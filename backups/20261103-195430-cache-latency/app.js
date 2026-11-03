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
const STATUS_POLL_MS = 2000;

/* Movement is coalesced and sent at most once per ~10 ms. The firmware owns
   final pacing: it accumulates these deltas and drains them at a safe cadence,
   so Wi-Fi jitter can never overwrite a pending HID delta. The timer only runs
   while input is pending. */
const MIN_MOVE_FLUSH_MS = 10;
const BACKPRESSURE_RETRY_MS = 16;
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
let statusInFlight = false;
let lastBleState = null;

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
    updateStatus();
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    releaseAllButtons(false);
    resetMotion();
    resetPadState();
    setPhoneState('warn', 'RECONNECTING…');
    scheduleReconnect();
  };

  socket.onerror = () => {
    /* onclose always follows; handled there to avoid double reconnects */
  };
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

async function updateStatus() {
  if (document.hidden || statusInFlight) return;
  statusInFlight = true;

  try {
    const response = await fetch('/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('status');
    const data = await response.json();
    setBleState(data.ble === true);
  } catch {
    setBleUnknown();
  } finally {
    statusInFlight = false;
  }
}

/* --------------------------- movement batching ------------------------- */

let moveRaw = { x: 0, y: 0 };       /* raw finger travel since last flush */
let moveRemainder = { x: 0, y: 0 }; /* preserved sub-pixel output */
let movePendingSince = 0;
let lastFlushAt = 0;

let scrollRaw = 0;
let scrollRemainder = 0;
let scrollCarry = 0;
let scrollHRaw = 0;
let scrollHRemainder = 0;
let scrollHCarry = 0;

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
  scheduleFlush();
}

function accumulateScroll(dy) {
  if (!dy) return;
  scrollRaw += dy;
  scheduleFlush();
}

function accumulateScrollH(dx) {
  if (!dx || !HORIZONTAL_SCROLL_ENABLED) return;
  scrollHRaw += dx;
  scheduleFlush();
}

function hasPendingInput() {
  return (
    moveRaw.x !== 0 || moveRaw.y !== 0 ||
    scrollRaw !== 0 || scrollCarry !== 0 ||
    scrollHRaw !== 0 || scrollHCarry !== 0
  );
}

function scheduleFlush(delay) {
  if (flushTimer) return;

  const wait =
    delay !== undefined
      ? delay
      : Math.max(0, MIN_MOVE_FLUSH_MS - (nowMs() - lastFlushAt));

  flushTimer = setTimeout(() => {
    flushTimer = 0;
    flushPending(nowMs());
  }, wait);
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

  lastFlushAt = now;
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
    scrollRawX: 0,
    scrollRawY: 0,
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

  event.preventDefault();

  try {
    pad.setPointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }

  const now = nowMs();

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
  }

  if (padPointers.size === 2) {
    gesture.scrollStartAt = now;
    gesture.lastCentroid = centroid();
    gesture.scrollAxis = null;
    gesture.scrollRawX = 0;
    gesture.scrollRawY = 0;
  } else if (padPointers.size >= 3) {
    /* Three or more fingers never scroll or move the cursor. */
    clearHoldTimer();
    gesture.scrollAxis = 'none';
    gesture.lastCentroid = null;
  }
});

pad.addEventListener('pointermove', event => {
  const pointer = padPointers.get(event.pointerId);
  if (!pointer) return;

  event.preventDefault();

  const previousX = pointer.x;
  const previousY = pointer.y;

  pointer.x = event.clientX;
  pointer.y = event.clientY;

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
    const current = centroid();

    if (!gesture.lastCentroid) {
      gesture.lastCentroid = current;
      return;
    }

    const dx = current.x - gesture.lastCentroid.x;
    const dy = current.y - gesture.lastCentroid.y;
    gesture.lastCentroid = current;

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
        accumulateScroll(initialY);
      }

      return;
    }

    if (gesture.scrollAxis === 'y') {
      accumulateScroll(dy);
    } else {
      accumulateScrollH(dx);
    }
  }
});

function finishPointer(event, cancelled) {
  if (!padPointers.has(event.pointerId)) return;

  padPointers.delete(event.pointerId);

  if (!gesture) {
    if (padPointers.size === 0) pad.classList.remove('touching');
    return;
  }

  if (cancelled) gesture.cancelled = true;

  if (padPointers.size === 1) {
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
  updateStatus();
  setInterval(updateStatus, STATUS_POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    releaseAllButtons(true);
    resetMotion();
    resetPadState();
  } else if (!ws) {
    connect();
    updateStatus();
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
  updateStatus();
});

window.addEventListener('offline', () => {
  setPhoneState('bad', 'PHONE OFFLINE');
});

startup();
