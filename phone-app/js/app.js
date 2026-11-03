'use strict';

/* =========================================================================
   ESP3D phone controller
   -------------------------------------------------------------------------
   Phase 2: coalesced pointer movement with fixed gain and backpressure
            handling. The firmware accumulates deltas so the phone never has
            to pace itself below the BLE report rate.
   Phase 3: multi-touch touchpad gestures (tap / scroll / hold-to-drag).
   Phase 4: configurable haptic feedback.

   Firmware protocol (unchanged):
     M dx dy     mouse movement (firmware clamps each axis to ±127)
     B L|R|M 0|1 button state
     S value     vertical scroll (-10..10)

   Note: horizontal scrolling is intentionally disabled. The HID library
   supports it and the firmware constructs the mouse with horizontalScroll
   enabled, but the firmware has no 'H' command yet. A separate firmware
   patch is required (see docs/firmware-horizontal-scroll-proposal.md).
   ========================================================================= */

/* ----------------------------- elements -------------------------------- */

const phoneStatus = document.getElementById('phoneStatus');
const bleStatus = document.getElementById('bleStatus');
const pad = document.getElementById('pad');
const padFeedback = document.getElementById('padFeedback');
const virtualButtons = document.getElementById('virtualButtons');
const virtualMouseInput = document.getElementById('virtualMouse');
const motionModeInput = document.getElementById('motionMode');
const recenterMotionButton = document.getElementById('recenterMotion');
const motionPermissionButton = document.getElementById('motionPermission');
const motionNote = document.getElementById('motionNote');

const sensitivityInput = document.getElementById('sensitivity');
const sensitivityValue = document.getElementById('sensitivityValue');
const scrollSensitivityInput = document.getElementById('scrollSensitivity');
const scrollSensitivityValue = document.getElementById('scrollSensitivityValue');
const naturalScrollInput = document.getElementById('naturalScroll');
const hapticsEnabledInput = document.getElementById('hapticsEnabled');
const hapticIntensityInput = document.getElementById('hapticIntensity');
const hapticIntensityValue = document.getElementById('hapticIntensityValue');
const connectionAlertsInput = document.getElementById('connectionAlerts');
const hapticTestButton = document.getElementById('hapticTest');
const hapticNote = document.getElementById('hapticNote');

/* ----------------------------- tunables -------------------------------- */

const WS_PORT = 81;
const WS_RECONNECT_MIN_MS = 500;
const WS_RECONNECT_MAX_MS = 5000;

/* A fixed-cadence heartbeat keeps the phone's Wi-Fi radio out of power save.
   With sparse traffic (a slow drag emits only a few packets per second) an
   Android radio can drop into power save and buffer packets until the next
   beacon, which shows up as the cursor stopping and then jumping. The ESP32
   uses the arrival gaps of these packets to measure the real link. */
const HEARTBEAT_MS = 30;

/* Each pointer event is flushed immediately. The firmware accumulates the
   deltas, so there is no need to pace the phone below the BLE report rate —
   waiting on a timer here only added input latency. */
const BACKPRESSURE_RETRY_MS = 16;
const MOVE_BATCH_MS = 2;
const MAX_MOVE_PER_MSG = 30000;   /* safety clamp; firmware chunks to ±127 */
const BACKPRESSURE_LIMIT = 2048;
const STALE_INPUT_MS = 180;

const TAP_MAX_MS = 320;
const TAP_MAX_MOVE_PX = 10;
const TAP_MAX_SPREAD_MS = 300;
const CLICK_HOLD_MS = 24;       /* guarantees one BLE report sees the press */

const HOLD_DRAG_MS = 400;         /* hold this long to latch the left button */
const HOLD_DRAG_MAX_MOVE_PX = 6;

const SCROLL_START_PX = 6;
const SCROLL_GAIN = 0.025;      /* wheel units per px of two-finger travel */
const MAX_SCROLL_PER_MSG = 127;
const HORIZONTAL_SCROLL_ENABLED = false;

/* Inertial scrolling after the fingers lift, similar to a MacBook trackpad.
   Velocity is measured in finger px per ms; it decays exponentially and the
   normal scroll gain converts it to wheel units. */
const MOMENTUM_SAMPLE_MS = 90;       /* velocity window before release */
const MOMENTUM_MIN_START = 0.06;     /* px/ms — below this, no coast */
const MOMENTUM_MAX_UNITS_PER_MS = 0.1; /* 100 ticks/s, below the HID drain rate */
const MOMENTUM_TAU_MS = 400;         /* exponential decay time constant */
const MOMENTUM_STOP_V = 0.015;       /* px/ms — end of the coast */
const MOMENTUM_MAX_MS = 2600;

/* Link latency probe (round trip to the ESP32 over Wi-Fi). */
const PING_INTERVAL_MS = 1500;

const HAPTIC = {
  left: 10,
  right: [10, 45, 12],
  middle: [8, 28, 8, 28, 10],
  drag: [8, 34, 12],
  gesture: 6,
  connect: [12, 70, 12],
  disconnect: [35, 70, 35],
};

/* ----------------------------- settings -------------------------------- */

const SETTINGS_KEY = 'esp3d.settings.v1';

const DEFAULT_SETTINGS = {
  sensitivity: 1.5,
  scrollSensitivity: 1,
  naturalScroll: true,
  haptics: true,
  hapticIntensity: 1,
  connectionAlerts: false,
  virtualMouse: false,
  motionMode: 'off',
};

let settings = { ...DEFAULT_SETTINGS };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;

  if (Number.isFinite(raw.sensitivity)) {
    s.sensitivity = clamp(raw.sensitivity, 0.5, 4);
  }
  if (Number.isFinite(raw.scrollSensitivity)) {
    s.scrollSensitivity = clamp(raw.scrollSensitivity, 0.4, 2.5);
  }
  if (Number.isFinite(raw.hapticIntensity)) {
    s.hapticIntensity = clamp(raw.hapticIntensity, 0.4, 2);
  }
  s.naturalScroll = raw.naturalScroll !== false;
  s.haptics = raw.haptics !== false;
  s.connectionAlerts = raw.connectionAlerts === true;
  s.virtualMouse = raw.virtualMouse === true;
  s.motionMode = raw.motionMode === 'off' ? 'off' : 'motion';
  return s;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = sanitizeSettings(JSON.parse(raw));
  } catch {
    /* localStorage can be unavailable in private mode — defaults are fine */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

/* --------------------------- haptic feedback --------------------------- */

const hapticsSupported = typeof navigator.vibrate === 'function';

function vibrate(pattern) {
  if (!settings.haptics || !hapticsSupported) return;

  try {
    const scale = settings.hapticIntensity;
    let scaled = pattern;

    if (Array.isArray(pattern)) {
      /* Even indexes are vibration durations, odd indexes are pauses. */
      scaled = pattern.map((ms, index) =>
        index % 2 === 0 ? Math.max(1, Math.round(ms * scale)) : ms
      );
    } else {
      scaled = Math.max(1, Math.round(pattern * scale));
    }

    navigator.vibrate(scaled);
  } catch {
    /* vibration can be rejected by the browser — never break control flow */
  }
}

let feedbackTimer = 0;

function showFeedback(text) {
  padFeedback.textContent = text;
  padFeedback.classList.add('show');
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    padFeedback.classList.remove('show');
    padFeedback.textContent = 'TOUCHPAD';
  }, 650);
}

/* --------------------------- WebSocket link ---------------------------- */

let ws = null;
let reconnectTimer = 0;
let reconnectDelay = WS_RECONNECT_MIN_MS;
let lastBleState = null;

/* Round-trip time to the ESP32, shown in the header so link latency can be
   told apart from BLE/pointer latency. */
let pingSeq = 0;
let pingAt = 0;
let linkRtt = 0;
let linkJitter = 0;
let linkBacklog = 0;

/* Delivery diagnostics.

   touchGap* measures the interval between real pointer samples on this page:
   a spike means Chrome or the touch panel stalled, not the network.
   linkGap*, loopMax and heartbeatCount come from the ESP32's P reply: the
   interval between our heartbeats as they arrive, and the firmware's longest
   main-loop stall. */
let heartbeatSeq = 0;
let lastTouchSampleAt = 0;
let touchGapSum = 0;
let touchGapMax = 0;
let touchGapCount = 0;
let linkGapMax = 0;
let linkGapMean = 0;
let linkLoopMax = 0;
let linkSampleCount = 0;

function socketUrl() {
  const host = location.hostname;
  const local =
    !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return `ws://${local ? '192.168.4.1' : host}:${WS_PORT}/`;
}

function setPhoneState(state, text) {
  phoneStatus.dataset.state = state;
  phoneStatus.textContent = text;
}

function setBleState(connected) {
  bleStatus.dataset.state = connected ? 'ok' : 'bad';
  bleStatus.textContent = connected ? 'BLE: CONNECTED' : 'BLE: WAITING';

  if (
    lastBleState !== null &&
    connected !== lastBleState &&
    settings.connectionAlerts
  ) {
    vibrate(connected ? HAPTIC.connect : HAPTIC.disconnect);
  }

  lastBleState = connected;
}

function setBleUnknown() {
  bleStatus.dataset.state = 'warn';
  bleStatus.textContent = 'BLE: UNKNOWN';
}

function connect() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = 0;

  setPhoneState('waiting', 'CONNECTING…');

  let socket;
  try {
    socket = new WebSocket(socketUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectDelay = WS_RECONNECT_MIN_MS;
    setPhoneState('ok', 'PHONE CONNECTED');
    setBleUnknown();
    pingLink();
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    pingAt = 0;
    lastTouchSampleAt = 0;
    releaseAllButtons(false);
    resetMotion();
    resetPadState();
    setPhoneState('warn', 'RECONNECTING…');
    setBleUnknown();
    scheduleReconnect();
  };

  socket.onerror = () => {
    /* onclose always follows; handled there to avoid double reconnects */
  };

  socket.onmessage = event => {
    if (ws !== socket) return;
    if (typeof event.data === 'string') handleIncoming(event.data);
  };
}

function handleIncoming(message) {
  if (message[0] === 'B' && message[1] === ' ') {
    setBleState(message[2] === '1');
    return;
  }

  if (message.length < 3 || message[0] !== 'P' || message[1] !== ' ') return;

  const parts = message.slice(2).split(' ');
  const seq = Number(parts[0]);
  if (!pingAt || seq !== pingSeq) return;

  const rtt = nowMs() - pingAt;
  pingAt = 0;

  /* Exponentially smoothed RTT and mean absolute jitter. */
  linkJitter = linkRtt
    ? linkJitter * 0.7 + Math.abs(rtt - linkRtt) * 0.3
    : 0;
  linkRtt = linkRtt ? linkRtt * 0.7 + rtt * 0.3 : rtt;

  /* P <seq> <backlog> <gapMax> <gapMean> <loopMax> <n> */
  linkBacklog = Number(parts[1]) || 0;
  linkGapMax = Number(parts[2]) || 0;
  linkGapMean = Number(parts[3]) || 0;
  linkLoopMax = Number(parts[4]) || 0;
  linkSampleCount = Number(parts[5]) || 0;

  renderLink();

  touchGapSum = 0;
  touchGapMax = 0;
  touchGapCount = 0;
}

function renderLink() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const shaky = linkJitter > 20;
  const busy = linkBacklog >= 3;
  const touchStall = touchGapMax > 30;
  const linkStall = linkGapMax > 120;

  let text = `PHONE CONNECTED · ${Math.round(linkRtt)} ms`;
  if (shaky) text += ` ±${Math.round(linkJitter)}`;
  if (busy) text += ' · BUSY';
  if (touchStall) text += ` · TOUCH ${Math.round(touchGapMax)}`;
  if (linkStall) text += ` · LINK ${Math.round(linkGapMax)}`;

  phoneStatus.dataset.state =
    (linkRtt > 60 || shaky || busy || touchStall || linkStall) ? 'warn' : 'ok';
  phoneStatus.textContent = text;

  phoneStatus.title =
    `RTT ${Math.round(linkRtt)} ms (jitter ${Math.round(linkJitter)})` +
    ` · touch max ${Math.round(touchGapMax)} ms (${touchGapCount} samples)` +
    ` · link max ${Math.round(linkGapMax)} ms / mean ${Math.round(linkGapMean)} ms` +
    ` (${linkSampleCount} packets)` +
    ` · firmware stall ${Math.round(linkLoopMax)} ms` +
    ` · backlog ${linkBacklog}`;
}

/* Gaps between real pointer samples. Duplicate deliveries (pointermove and
   pointerrawupdate for the same position) are filtered out by the caller so
   a zero gap cannot hide a later stall. */
function noteTouchSample(now) {
  if (lastTouchSampleAt) {
    const gap = now - lastTouchSampleAt;
    if (gap > 0 && gap < 500) {
      touchGapSum += gap;
      if (gap > touchGapMax) touchGapMax = gap;
      touchGapCount++;
    }
  }
  lastTouchSampleAt = now;
}

/* Keeps the Wi-Fi link hot so Android does not enter power save between
   sparse movement packets. Also gives the ESP32 a fixed-cadence signal to
   measure the real arrival jitter. */
function heartbeat() {
  if (document.hidden) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > BACKPRESSURE_LIMIT) return;

  heartbeatSeq = (heartbeatSeq + 1) % 1000000;
  send(`K ${heartbeatSeq}`);
}

function pingLink() {
  if (document.hidden) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  pingSeq = (pingSeq + 1) % 1000000;
  pingAt = nowMs();
  send(`P ${pingSeq}`);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, reconnectDelay);

  reconnectDelay = Math.min(
    WS_RECONNECT_MAX_MS,
    Math.round(reconnectDelay * 1.6)
  );
}

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(message);
    return true;
  } catch {
    return false;
  }
}

/* BLE status arrives as a WebSocket push ("B 0" / "B 1") from the firmware.
   The old /status HTTP poll is gone: on a single-threaded ESP32 that fetch
   opened a TCP connection and could block the loop, which is exactly the
   path a movement packet needs. /status still exists for manual checks. */

/* --------------------------- movement batching ------------------------- */

let moveRaw = { x: 0, y: 0 };       /* raw finger travel since last flush */
let moveRemainder = { x: 0, y: 0 }; /* preserved sub-pixel output */
let movePendingSince = 0;

let scrollRaw = 0;
let scrollRemainder = 0;
let scrollCarry = 0;
let scrollHRaw = 0;
let scrollHRemainder = 0;
let scrollHCarry = 0;

let momentumFrame = 0;
let momentumVelocity = 0;   /* px/ms, signed like finger movement */
let momentumLastAt = 0;
let momentumStartedAt = 0;

let flushTimer = 0;

function nowMs() {
  return performance.now();
}

function accumulateMove(dx, dy) {
  if (!dx && !dy) return;

  if (moveRaw.x === 0 && moveRaw.y === 0) {
    movePendingSince = nowMs();
  }

  moveRaw.x += dx;
  moveRaw.y += dy;
  scheduleFlush(MOVE_BATCH_MS);
}

function accumulateScroll(dy) {
  if (!dy) return;
  scrollRaw += dy;
  flushNow();
}

function accumulateScrollH(dx) {
  if (!dx || !HORIZONTAL_SCROLL_ENABLED) return;
  scrollHRaw += dx;
  flushNow();
}

function stopMomentum() {
  if (momentumFrame) {
    cancelAnimationFrame(momentumFrame);
    momentumFrame = 0;
  }
  momentumVelocity = 0;
}

function startMomentum(velocity) {
  stopMomentum();

  if (!Number.isFinite(velocity)) return;

  /* Two independent limits: the finger velocity stays physical, and the
     resulting wheel rate stays below the HID library's one-tick-per-report
     drain so the coast cannot overshoot after the animation ends. */
  let v = clamp(velocity, -3, 3);

  const gain = SCROLL_GAIN * settings.scrollSensitivity;
  if (gain <= 0) return;

  const maxVelocity = MOMENTUM_MAX_UNITS_PER_MS / gain;
  v = clamp(v, -maxVelocity, maxVelocity);

  if (Math.abs(v) < MOMENTUM_MIN_START) return;

  momentumVelocity = v;
  momentumLastAt = nowMs();
  momentumStartedAt = momentumLastAt;
  momentumFrame = requestAnimationFrame(stepMomentum);
}

function stepMomentum(now) {
  momentumFrame = 0;

  const dt = Math.min(50, Math.max(1, now - momentumLastAt));
  momentumLastAt = now;

  /* Exact integral of v0 * exp(-t / tau) over this frame, so the coast
     distance is identical at 60 Hz and 120 Hz displays. */
  const decay = Math.exp(-dt / MOMENTUM_TAU_MS);
  const distance = momentumVelocity * MOMENTUM_TAU_MS * (1 - decay);
  momentumVelocity *= decay;

  if (
    Math.abs(momentumVelocity) < MOMENTUM_STOP_V ||
    now - momentumStartedAt >= MOMENTUM_MAX_MS
  ) {
    momentumVelocity = 0;
    return;
  }

  scrollRaw += distance;
  flushNow();

  momentumFrame = requestAnimationFrame(stepMomentum);
}

function hasPendingInput() {
  return (
    moveRaw.x !== 0 || moveRaw.y !== 0 ||
    scrollRaw !== 0 || scrollCarry !== 0 ||
    scrollHRaw !== 0 || scrollHCarry !== 0
  );
}

function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  flushPending(nowMs());
}

function scheduleFlush(delay) {
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = 0;
    flushPending(nowMs());
  }, delay === undefined ? 0 : delay);
}

function flushPending(now) {
  if (!hasPendingInput()) return;

  const open = ws && ws.readyState === WebSocket.OPEN;
  const backpressured = !open || ws.bufferedAmount > BACKPRESSURE_LIMIT;

  if (backpressured) {
    /* Do not silently drop a short burst. Only discard motion if the link
       has been stalled long enough that replaying it would feel wrong. */
    const age = movePendingSince ? now - movePendingSince : 0;
    if (age > STALE_INPUT_MS) {
      resetMotion();
    } else {
      scheduleFlush(BACKPRESSURE_RETRY_MS);
    }
    return;
  }

  flushMovement(now);
  flushScroll();

  if (hasPendingInput()) {
    scheduleFlush();
  }
}

function flushMovement() {
  const hasWork =
    moveRaw.x !== 0 || moveRaw.y !== 0 ||
    moveRemainder.x !== 0 || moveRemainder.y !== 0;

  if (!hasWork) return;

  /* Fixed gain only. macOS already applies its own pointer acceleration;
     adding a software curve on top made the cursor feel unpredictable. */
  const gain = settings.sensitivity;

  let outX = moveRaw.x * gain + moveRemainder.x;
  let outY = moveRaw.y * gain + moveRemainder.y;

  moveRaw.x = 0;
  moveRaw.y = 0;
  movePendingSince = 0;

  const truncatedX = Math.trunc(outX);
  const truncatedY = Math.trunc(outY);

  moveRemainder.x = outX - truncatedX;
  moveRemainder.y = outY - truncatedY;

  /* The firmware accumulates and chunks these values, so a large delta is
     never split or dropped on the phone side. */
  const ix = clamp(truncatedX, -MAX_MOVE_PER_MSG, MAX_MOVE_PER_MSG);
  const iy = clamp(truncatedY, -MAX_MOVE_PER_MSG, MAX_MOVE_PER_MSG);

  if (ix || iy) send(`M ${ix} ${iy}`);
}

function flushScroll() {
  if (scrollRaw !== 0 || scrollRemainder !== 0 || scrollCarry !== 0) {
    /* macOS inverts wheel direction when natural scrolling is enabled.
       A negative value makes content follow a downward finger. */
    const sign = settings.naturalScroll ? -1 : 1;
    let value =
      scrollRaw * SCROLL_GAIN * settings.scrollSensitivity * sign +
      scrollRemainder +
      scrollCarry;

    scrollRaw = 0;
    scrollRemainder = 0;
    scrollCarry = 0;

    let units = Math.trunc(value);
    scrollRemainder = value - units;

    if (Math.abs(units) > MAX_SCROLL_PER_MSG) {
      const dir = Math.sign(units);
      scrollCarry = units - dir * MAX_SCROLL_PER_MSG;
      units = dir * MAX_SCROLL_PER_MSG;
    }

    if (units) send(`S ${units}`);
  }

  if (scrollHRaw !== 0 || scrollHRemainder !== 0 || scrollHCarry !== 0) {
    let value =
      scrollHRaw * SCROLL_GAIN * settings.scrollSensitivity +
      scrollHRemainder +
      scrollHCarry;

    scrollHRaw = 0;
    scrollHRemainder = 0;
    scrollHCarry = 0;

    let units = Math.trunc(value);
    scrollHRemainder = value - units;

    if (Math.abs(units) > MAX_SCROLL_PER_MSG) {
      const dir = Math.sign(units);
      scrollHCarry = units - dir * MAX_SCROLL_PER_MSG;
      units = dir * MAX_SCROLL_PER_MSG;
    }

    if (units) send(`H ${units}`);
  }
}

function resetMotion() {
  stopMomentum();

  moveRaw.x = 0;
  moveRaw.y = 0;
  moveRemainder.x = 0;
  moveRemainder.y = 0;
  movePendingSince = 0;

  scrollRaw = 0;
  scrollRemainder = 0;
  scrollCarry = 0;
  scrollHRaw = 0;
  scrollHRemainder = 0;
  scrollHCarry = 0;

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
}

function resetPadState() {
  stopMomentum();
  clearHoldTimer();
  endDrag();
  padPointers.clear();
  gesture = null;
  pad.classList.remove('touching');
}

/* ------------------------- buttons and clicks -------------------------- */

const heldButtons = new Set();
const clickTimers = new Map();

function cancelClick(code) {
  const pending = clickTimers.get(code);
  if (pending) {
    clearTimeout(pending);
    clickTimers.delete(code);
  }
}

function click(code) {
  if (heldButtons.size > 0) {
    showFeedback('BUTTON HELD');
    return;
  }

  const pending = clickTimers.get(code);

  if (pending) {
    clearTimeout(pending);
  } else {
    send(`B ${code} 1`);
  }

  clickTimers.set(
    code,
    setTimeout(() => {
      clickTimers.delete(code);
      send(`B ${code} 0`);
    }, CLICK_HOLD_MS)
  );
}

function releaseAllButtons(trySend) {
  for (const code of heldButtons) {
    if (trySend) send(`B ${code} 0`);
  }
  heldButtons.clear();

  for (const [code, timer] of clickTimers) {
    clearTimeout(timer);
    if (trySend) send(`B ${code} 0`);
  }
  clickTimers.clear();
  virtualButtonPointers.clear();
}

const virtualButtonPointers = new Map();

/* ------------------------- accelerometer mouse ------------------------- */

const MOTION_DEADZONE = 0.18;
const MOTION_DAMPING = 0.86;
const MOTION_GAIN = 145;
const GYRO_DEADZONE = 1.5;
const GYRO_GAIN = 5.5;
const FUSION_ACCEL_WEIGHT = 0.02;
const FUSION_LINEAR_ACCEL_GAIN = 110;
const FALLBACK_ACCEL_BASELINE_WEIGHT = 0.12;
let motionEnabled = false;
let motionMode = 'off';
let motionFrame = 0;
let motionLastAt = 0;
let motionVelocityX = 0;
let motionVelocityY = 0;
let motionPermissionPending = false;
let fusionAngleX = 0;
let fusionAngleY = 0;
let fusionSensorAt = 0;
let fallbackAccelX = 0;
let fallbackAccelY = 0;
let fallbackAccelReady = false;

function motionSupported() {
  return window.isSecureContext &&
    (typeof window.DeviceMotionEvent === 'function' ||
      typeof window.DeviceMotionEvent === 'object');
}

function recenterMotion() {
  motionVelocityX = 0;
  motionVelocityY = 0;
  motionLastAt = 0;
  fusionAngleX = 0;
  fusionAngleY = 0;
  fusionSensorAt = 0;
  fallbackAccelX = 0;
  fallbackAccelY = 0;
  fallbackAccelReady = false;
  resetMotion();
  showFeedback('MOTION RECENTERED');
}

function stopMotionMouse() {
  motionEnabled = false;
  if (motionFrame) {
    cancelAnimationFrame(motionFrame);
    motionFrame = 0;
  }
  window.removeEventListener('devicemotion', handleMotion);
  recenterMotion();
  motionPermissionButton.hidden = true;
  pad.classList.remove('motion-active');
}

function motionStep(now) {
  motionFrame = 0;
  if (!motionEnabled) return;

  if (motionLastAt) {
    const dt = Math.min(40, Math.max(1, now - motionLastAt)) / 1000;
    motionVelocityX *= Math.pow(MOTION_DAMPING, dt * 60);
    motionVelocityY *= Math.pow(MOTION_DAMPING, dt * 60);

    const dx = motionVelocityX * dt * settings.sensitivity;
    const dy = motionVelocityY * dt * settings.sensitivity;
    if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
      accumulateMove(dx, dy);
    }
  }

  motionLastAt = now;
  motionFrame = requestAnimationFrame(motionStep);
}

function handleMotion(event) {
  if (!motionEnabled) return;

  if (motionMode === 'motion') {
    const rotation = event.rotationRate;
    const hasRotation = rotation &&
      Number.isFinite(rotation.beta) && Number.isFinite(rotation.gamma);
    const linear = event.acceleration;
    const hasLinearAcceleration = linear &&
      Number.isFinite(linear.x) && Number.isFinite(linear.y);
    const sensorAt = Number.isFinite(event.timeStamp) && event.timeStamp > 0
      ? event.timeStamp : performance.now();
    const gravity = event.accelerationIncludingGravity;
    const hasGravity = gravity && Number.isFinite(gravity.x) &&
      Number.isFinite(gravity.y) && Number.isFinite(gravity.z);
    if (!hasRotation && !hasLinearAcceleration && !hasGravity) {
      motionNote.hidden = false;
      return;
    }
    const dt = fusionSensorAt
      ? Math.min(0.05, Math.max(0.001, (sensorAt - fusionSensorAt) / 1000))
      : 0;
    fusionSensorAt = sensorAt;

    const gyroX = hasRotation && Math.abs(rotation.gamma) > GYRO_DEADZONE
      ? -rotation.gamma : 0;
    const gyroY = hasRotation && Math.abs(rotation.beta) > GYRO_DEADZONE
      ? -rotation.beta : 0;

    if (!dt) {
      if (hasGravity) {
        fusionAngleX = -Math.atan2(
          gravity.x, Math.hypot(gravity.y, gravity.z)
        ) * 180 / Math.PI;
        fusionAngleY = -Math.atan2(
          gravity.y, Math.hypot(gravity.x, gravity.z)
        ) * 180 / Math.PI;
      }
      return;
    }

    fusionAngleX += gyroX * dt;
    fusionAngleY += gyroY * dt;

    if (hasGravity) {
      const accelX = -Math.atan2(
        gravity.x, Math.hypot(gravity.y, gravity.z)
      ) * 180 / Math.PI;
      const accelY = -Math.atan2(
        gravity.y, Math.hypot(gravity.x, gravity.z)
      ) * 180 / Math.PI;
      fusionAngleX += (accelX - fusionAngleX) * FUSION_ACCEL_WEIGHT;
      fusionAngleY += (accelY - fusionAngleY) * FUSION_ACCEL_WEIGHT;
    }

    /* Gravity correction stabilizes the fused attitude state, but must not be
       emitted as cursor motion: doing so makes the cursor return when the
       phone is held at a new angle. */
    motionVelocityX += gyroX * GYRO_GAIN;
    motionVelocityY += gyroY * GYRO_GAIN;
    let linearX = hasLinearAcceleration ? linear.x : 0;
    let linearY = hasLinearAcceleration ? linear.y : 0;
    if (!hasLinearAcceleration && hasGravity) {
      if (!fallbackAccelReady) {
        fallbackAccelX = gravity.x;
        fallbackAccelY = gravity.y;
        fallbackAccelReady = true;
      }
      linearX = gravity.x - fallbackAccelX;
      linearY = gravity.y - fallbackAccelY;
      fallbackAccelX += (gravity.x - fallbackAccelX) *
        FALLBACK_ACCEL_BASELINE_WEIGHT;
      fallbackAccelY += (gravity.y - fallbackAccelY) *
        FALLBACK_ACCEL_BASELINE_WEIGHT;
    }
    if (hasLinearAcceleration || fallbackAccelReady) {
      linearX = Math.abs(linearX) > MOTION_DEADZONE ? linearX : 0;
      linearY = Math.abs(linearY) > MOTION_DEADZONE ? linearY : 0;
      motionVelocityX += linearX * FUSION_LINEAR_ACCEL_GAIN;
      motionVelocityY -= linearY * FUSION_LINEAR_ACCEL_GAIN;
    }
    return;
  }

  const acceleration = event.acceleration;
  if (!acceleration || !Number.isFinite(acceleration.x) ||
      !Number.isFinite(acceleration.y)) {
    motionNote.hidden = false;
    return;
  }

  const x = Math.abs(acceleration.x) > MOTION_DEADZONE
    ? acceleration.x : 0;
  const y = Math.abs(acceleration.y) > MOTION_DEADZONE
    ? acceleration.y : 0;

  motionVelocityX += x * MOTION_GAIN;
  motionVelocityY -= y * MOTION_GAIN;
}

async function startMotionMouse() {
  if (!motionSupported()) {
    motionNote.hidden = false;
    motionPermissionButton.hidden = true;
    return;
  }

  if (
    typeof window.DeviceMotionEvent.requestPermission === 'function' &&
    !motionPermissionPending
  ) {
    motionPermissionPending = true;
    try {
      const permission = await window.DeviceMotionEvent.requestPermission();
      if (permission !== 'granted') throw new Error('Motion permission denied');
    } catch (error) {
      motionNote.hidden = false;
      motionPermissionButton.hidden = false;
      return;
    } finally {
      motionPermissionPending = false;
    }
  }

  motionNote.hidden = true;
  motionPermissionButton.hidden = true;
  motionEnabled = true;
  recenterMotionButton.hidden = false;
  pad.classList.add('motion-active');
  window.addEventListener('devicemotion', handleMotion);
  motionFrame = requestAnimationFrame(motionStep);
  showFeedback('MOTION MOUSE');
}

function setMotionMode(mode) {
  stopMotionMouse();
  motionMode = mode;
  if (mode !== 'off') startMotionMouse();
  else recenterMotionButton.hidden = true;
}

function releaseVirtualButton(pointerId) {
  const code = virtualButtonPointers.get(pointerId);
  if (!code) return;

  virtualButtonPointers.delete(pointerId);
  const stillPressed = [...virtualButtonPointers.values()].includes(code);
  const dragOwnsLeft = code === 'L' && gesture && gesture.dragging;

  if (!stillPressed && !dragOwnsLeft) {
    heldButtons.delete(code);
    send(`B ${code} 0`);
  }
}

for (const button of virtualButtons.querySelectorAll('button')) {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    const code = button.dataset.button;
    if (!code || virtualButtonPointers.has(event.pointerId)) return;

    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is optional on some mobile browsers */
    }

    virtualButtonPointers.set(event.pointerId, code);
    heldButtons.add(code);
    send(`B ${code} 1`);
    vibrate(code === 'L' ? HAPTIC.left : code === 'R' ? HAPTIC.right : HAPTIC.middle);
  });

  button.addEventListener('pointerup', event => {
    event.preventDefault();
    releaseVirtualButton(event.pointerId);
  });
  button.addEventListener('pointercancel', event => {
    releaseVirtualButton(event.pointerId);
  });
  button.addEventListener('lostpointercapture', event => {
    releaseVirtualButton(event.pointerId);
  });
}

/* --------------------------- touchpad gestures ------------------------- */

const padPointers = new Map();
let gesture = null;

function centroid() {
  let x = 0;
  let y = 0;

  for (const pointer of padPointers.values()) {
    x += pointer.x;
    y += pointer.y;
  }

  const count = padPointers.size || 1;
  return { x: x / count, y: y / count };
}

function recordScrollSample(now) {
  if (!gesture) return;

  const current = centroid();
  gesture.scrollSamples.push({ t: now, x: current.x, y: current.y });

  const cutoff = now - MOMENTUM_SAMPLE_MS;
  while (
    gesture.scrollSamples.length &&
    gesture.scrollSamples[0].t < cutoff
  ) {
    gesture.scrollSamples.shift();
  }

  gesture.lastScrollAt = now;
}

function scrollReleaseVelocity(now) {
  if (!gesture) return 0;

  const cutoff = now - MOMENTUM_SAMPLE_MS;
  let first = null;
  let last = null;

  for (const sample of gesture.scrollSamples) {
    if (sample.t < cutoff) continue;
    if (!first) first = sample;
    last = sample;
  }

  if (!first || !last || first === last) return 0;

  const dt = last.t - first.t;
  if (dt < 8) return 0;

  return (last.y - first.y) / dt;
}

function newGesture(now) {
  return {
    startedAt: now,
    lastDownAt: now,
    maxPointers: 1,
    maxDist: 0,
    moved: false,
    cancelled: false,
    scrollAxis: null,     /* null = undecided, 'x' / 'y' = locked, 'none' */
    scrollStartAt: now,
    lastCentroid: null,
    lastMoveAt: now,
    scrollRawX: 0,
    scrollRawY: 0,
    scrollSamples: [],
    didScrollY: false,
    releaseVelY: 0,
    releaseAt: 0,
    lastScrollAt: 0,
    holdTimer: 0,
    dragging: false,
  };
}

function clearHoldTimer() {
  if (gesture && gesture.holdTimer) {
    clearTimeout(gesture.holdTimer);
    gesture.holdTimer = 0;
  }
}

function beginDrag() {
  if (!gesture || gesture.dragging || padPointers.size !== 1) return;

  gesture.holdTimer = 0;
  gesture.dragging = true;
  gesture.moved = true;

  /* Never let a pending tap release cancel the press we are starting. */
  cancelClick('L');
  heldButtons.add('L');
  send('B L 1');

  vibrate(HAPTIC.drag);
  showFeedback('DRAG');
}

function endDrag() {
  if (!gesture || !gesture.dragging) return;

  gesture.dragging = false;
  heldButtons.delete('L');
  send('B L 0');
}

function scheduleHold() {
  if (!gesture) return;

  const current = gesture;
  current.holdTimer = setTimeout(() => {
    if (gesture === current) beginDrag();
  }, HOLD_DRAG_MS);
}

pad.addEventListener('pointerdown', event => {
  if (padPointers.has(event.pointerId)) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  stopMomentum();
  event.preventDefault();

  try {
    pad.setPointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }

  const now = nowMs();

  /* Start a fresh gap window for each gesture: the interval between gestures
     is not a delivery gap. */
  if (padPointers.size === 0) {
    lastTouchSampleAt = 0;
    touchGapSum = 0;
    touchGapMax = 0;
    touchGapCount = 0;
  }

  padPointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
  });

  pad.classList.add('touching');

  if (!gesture) {
    gesture = newGesture(now);
    scheduleHold();
  } else {
    clearHoldTimer();
    if (gesture.dragging) endDrag();

    gesture.lastDownAt = now;
    gesture.maxPointers = Math.max(gesture.maxPointers, padPointers.size);
    gesture.lastCentroid = centroid();
    gesture.scrollStartAt = now;
    gesture.scrollAxis = null;
    gesture.scrollRawX = 0;
    gesture.scrollRawY = 0;
    gesture.scrollSamples = [];
    gesture.didScrollY = false;
    gesture.releaseVelY = 0;
    gesture.releaseAt = 0;
  }

  if (padPointers.size === 2) {
    gesture.scrollStartAt = now;
    gesture.lastCentroid = centroid();
    gesture.lastMoveAt = now;
    gesture.scrollAxis = null;
    gesture.scrollRawX = 0;
    gesture.scrollRawY = 0;
    gesture.scrollSamples = [];
    gesture.didScrollY = false;
    gesture.releaseVelY = 0;
    gesture.releaseAt = 0;
  } else if (padPointers.size >= 3) {
    /* Three or more fingers never scroll or move the cursor. */
    clearHoldTimer();
    gesture.scrollAxis = 'none';
    gesture.lastCentroid = null;
  }
});

function handlePointerMove(event) {
  const pointer = padPointers.get(event.pointerId);
  if (!pointer) return;

  event.preventDefault();

  const previousX = pointer.x;
  const previousY = pointer.y;

  pointer.x = event.clientX;
  pointer.y = event.clientY;

  /* Only a real position change counts as a sample. pointermove and
     pointerrawupdate can both deliver the same position; counting that twice
     would add a 0 ms gap and hide a later stall. */
  if (pointer.x !== previousX || pointer.y !== previousY) {
    noteTouchSample(nowMs());
  }

  const distance = Math.hypot(
    pointer.x - pointer.startX,
    pointer.y - pointer.startY
  );

  if (!gesture) return;

  gesture.maxDist = Math.max(gesture.maxDist, distance);

  const count = padPointers.size;

  if (count === 1) {
    /* If this gesture has ever used more than one finger, lifting back to
       one finger must not resume cursor movement (it would jump). */
    if (gesture.maxPointers !== 1) return;

    if (!gesture.dragging &&
        gesture.holdTimer &&
        gesture.maxDist > HOLD_DRAG_MAX_MOVE_PX) {
      clearHoldTimer();
    }

    accumulateMove(pointer.x - previousX, pointer.y - previousY);
    return;
  }

  if (count === 2 && gesture.scrollAxis !== 'none') {
    const now = nowMs();
    const current = centroid();

    if (!gesture.lastCentroid) {
      gesture.lastCentroid = current;
      return;
    }

    const dx = current.x - gesture.lastCentroid.x;
    const dy = current.y - gesture.lastCentroid.y;
    gesture.lastCentroid = current;

    /* Time since the previous two-finger sample, used to seed the flick
       velocity. Using the gesture start would misjudge a flick that begins
       after the fingers rested. */
    const moveDt = Math.max(8, now - (gesture.lastMoveAt || now));
    gesture.lastMoveAt = now;

    if (!gesture.scrollAxis) {
      gesture.scrollRawX += dx;
      gesture.scrollRawY += dy;

      if (
        Math.hypot(gesture.scrollRawX, gesture.scrollRawY) < SCROLL_START_PX
      ) {
        return;
      }

      gesture.scrollAxis =
        Math.abs(gesture.scrollRawX) >= Math.abs(gesture.scrollRawY)
          ? 'x'
          : 'y';
      gesture.moved = true;

      /* Apply the movement that selected the axis instead of discarding it,
         so scrolling starts with the finger rather than after a dead zone. */
      const initialX = gesture.scrollRawX;
      const initialY = gesture.scrollRawY;
      gesture.scrollRawX = 0;
      gesture.scrollRawY = 0;

      vibrate(HAPTIC.gesture);

      if (gesture.scrollAxis === 'x') {
        showFeedback(
          HORIZONTAL_SCROLL_ENABLED ? 'SCROLL ↔' : 'H-SCROLL UNAVAILABLE'
        );
        accumulateScrollH(initialX);
      } else {
        showFeedback('SCROLL');
        gesture.didScrollY = true;
        gesture.lastScrollAt = now;

        /* Seed the velocity window with the movement that locked the axis,
           so a short flick can still coast. */
        gesture.scrollSamples = [
          {
            t: now - moveDt,
            x: current.x - initialX,
            y: current.y - initialY,
          },
          { t: now, x: current.x, y: current.y },
        ];

        accumulateScroll(initialY);
      }

      return;
    }

    if (gesture.scrollAxis === 'y') {
      gesture.didScrollY = true;
      recordScrollSample(now);
      accumulateScroll(dy);
    } else {
      accumulateScrollH(dx);
    }
  }
}

/* Chrome can deliver raw touch samples before they are coalesced into a
   frame, cutting up to one display frame of input latency. Both handlers use
   the same code path: movement is the difference from the last stored
   position, so a duplicate delivery contributes zero. */
pad.addEventListener('pointermove', handlePointerMove);

if ('onpointerrawupdate' in pad) {
  pad.addEventListener('pointerrawupdate', handlePointerMove);
}

function finishPointer(event, cancelled) {
  if (!padPointers.has(event.pointerId)) return;

  padPointers.delete(event.pointerId);

  if (!gesture) {
    if (padPointers.size === 0) pad.classList.remove('touching');
    return;
  }

  if (cancelled) gesture.cancelled = true;

  if (padPointers.size === 1) {
    /* Remember the swipe velocity before the gesture stops scrolling. */
    if (gesture.didScrollY && !cancelled) {
      const now = nowMs();
      gesture.releaseVelY = scrollReleaseVelocity(now);
      gesture.releaseAt = now;
    }

    /* Stop scrolling when one of two fingers lifts; the remaining finger
       must not take over as a cursor. */
    gesture.scrollAxis = 'none';
    gesture.lastCentroid = centroid();
  }

  if (padPointers.size > 0) return;

  clearHoldTimer();
  endDrag();
  pad.classList.remove('touching');

  const finished = gesture;
  gesture = null;

  if (
    finished &&
    finished.didScrollY &&
    !finished.cancelled &&
    finished.maxPointers === 2 &&
    finished.releaseAt &&
    nowMs() - finished.releaseAt < 250
  ) {
    startMomentum(finished.releaseVelY);
  }

  evaluateTap(finished);
}

pad.addEventListener('pointerup', event => finishPointer(event, false));
pad.addEventListener('pointercancel', event => finishPointer(event, true));

pad.addEventListener('lostpointercapture', event => {
  /* Only treat this as a cancel if the pointer is still logically down. */
  if (padPointers.has(event.pointerId)) finishPointer(event, true);
});

pad.addEventListener('contextmenu', event => event.preventDefault());

function evaluateTap(finished) {
  if (!finished || finished.cancelled || finished.moved) return;

  const duration = nowMs() - finished.startedAt;
  const spread = finished.lastDownAt - finished.startedAt;

  if (
    duration > TAP_MAX_MS ||
    spread > TAP_MAX_SPREAD_MS ||
    finished.maxDist > TAP_MAX_MOVE_PX
  ) {
    return;
  }

  if (finished.maxPointers === 1) {
    click('L');
    vibrate(HAPTIC.left);
    showFeedback('LEFT CLICK');
  } else if (finished.maxPointers === 2) {
    click('R');
    vibrate(HAPTIC.right);
    showFeedback('RIGHT CLICK');
  } else if (finished.maxPointers === 3) {
    click('M');
    vibrate(HAPTIC.middle);
    showFeedback('MIDDLE CLICK');
  }
}

/* ----------------------------- settings UI ----------------------------- */

function refreshSettingLabels() {
  sensitivityValue.textContent = settings.sensitivity.toFixed(1) + '×';
  scrollSensitivityValue.textContent =
    settings.scrollSensitivity.toFixed(1) + '×';
  hapticIntensityValue.textContent =
    settings.hapticIntensity.toFixed(1) + '×';
}

function applySettingsToControls() {
  sensitivityInput.value = String(settings.sensitivity);
  scrollSensitivityInput.value = String(settings.scrollSensitivity);
  naturalScrollInput.checked = settings.naturalScroll;
  hapticsEnabledInput.checked = settings.haptics;
  hapticIntensityInput.value = String(settings.hapticIntensity);
  connectionAlertsInput.checked = settings.connectionAlerts;
  virtualMouseInput.checked = settings.virtualMouse;
  virtualButtons.hidden = !settings.virtualMouse;
  motionModeInput.value = settings.motionMode;
  recenterMotionButton.hidden = settings.motionMode === 'off';

  hapticIntensityInput.disabled = !settings.haptics;
  hapticTestButton.disabled = !settings.haptics || !hapticsSupported;

  refreshSettingLabels();
}

function initSettings() {
  loadSettings();
  applySettingsToControls();

  sensitivityInput.addEventListener('input', () => {
    settings.sensitivity = clamp(Number(sensitivityInput.value), 0.5, 4);
    refreshSettingLabels();
    saveSettings();
  });

  scrollSensitivityInput.addEventListener('input', () => {
    settings.scrollSensitivity = clamp(
      Number(scrollSensitivityInput.value),
      0.4,
      2.5
    );
    refreshSettingLabels();
    saveSettings();
  });

  naturalScrollInput.addEventListener('change', () => {
    settings.naturalScroll = naturalScrollInput.checked;
    saveSettings();
  });

  hapticsEnabledInput.addEventListener('change', () => {
    settings.haptics = hapticsEnabledInput.checked;
    hapticIntensityInput.disabled = !settings.haptics;
    hapticTestButton.disabled = !settings.haptics || !hapticsSupported;
    saveSettings();
    if (settings.haptics) vibrate(HAPTIC.gesture);
  });

  hapticIntensityInput.addEventListener('input', () => {
    settings.hapticIntensity = clamp(
      Number(hapticIntensityInput.value),
      0.4,
      2
    );
    refreshSettingLabels();
    saveSettings();
  });

  connectionAlertsInput.addEventListener('change', () => {
    settings.connectionAlerts = connectionAlertsInput.checked;
    saveSettings();
  });

  virtualMouseInput.addEventListener('change', () => {
    settings.virtualMouse = virtualMouseInput.checked;
    virtualButtons.hidden = !settings.virtualMouse;
    if (!settings.virtualMouse) releaseAllButtons(true);
    saveSettings();
  });

  motionModeInput.addEventListener('change', () => {
    settings.motionMode = motionModeInput.value;
    saveSettings();
    setMotionMode(settings.motionMode);
  });

  recenterMotionButton.addEventListener('click', recenterMotion);
  motionPermissionButton.addEventListener('click', () => {
    if (motionMode !== 'off') startMotionMouse();
  });

  hapticTestButton.addEventListener('click', () => {
    vibrate([12, 60, 12]);
  });

  if (!hapticsSupported) {
    hapticNote.hidden = false;
    hapticTestButton.disabled = true;
  }
}

/* ------------------------------- startup ------------------------------- */

function startup() {
  initSettings();

  connect();
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(pingLink, PING_INTERVAL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseAllButtons(true);
    resetMotion();
    resetPadState();
  } else {
    if (!ws) connect();
    heartbeat();
    pingLink();
  }
});

window.addEventListener('pagehide', () => {
  releaseAllButtons(true);
  resetMotion();
  resetPadState();
});

window.addEventListener('blur', () => {
  releaseAllButtons(true);
  resetPadState();
});

window.addEventListener('online', () => {
  reconnectDelay = WS_RECONNECT_MIN_MS;
  connect();
});

window.addEventListener('offline', () => {
  setPhoneState('bad', 'PHONE OFFLINE');
});

startup();
