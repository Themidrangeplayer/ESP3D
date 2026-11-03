# Hold-to-drag, fixed gain, and firmware delta accumulation

Date: 2026-11-03
Status: build 2026-11-03-5 flashed 2026-11-03 (upload hash verified, flash
digest verified against the file, boot log clean, BLE reconnected).

## Build 2026-11-03-5 — onboard status LED

Non-blocking status LED on `STATUS_LED_PIN` (GPIO2, the blue LED on most ESP32
dev boards; `STATUS_LED_ACTIVE_HIGH` flips the polarity). No `delay()` is used:
the pattern is advanced from `loop()`.

| Pattern | Meaning |
| --- | --- |
| 1 Hz blink | No phone connected to the WebSocket |
| 4 Hz blink | Phone connected, waiting for the Mac (BLE not paired) |
| Two short pulses every 2 s | Ready: phone + BLE both connected |
| Solid | Input is flowing (movement, button, scroll) |

The activity flash is 15 ms, so it merges into a steady light during a drag
and is invisible when idle. If the board's LED is not on GPIO2, change the two
constants at the top of the sketch.

## Build 2026-11-03-6 — synchronized HID movement drain

The firmware now drains accumulated movement on a fixed 7 ms cadence matching
the HID report task. The previous 8 ms guard drifted against that task and
occasionally caused a pending delta to be overwritten, producing stutter.
Wi-Fi modem sleep remains enabled to avoid unnecessary radio contention.

Movement samples are also coalesced on the phone for 2 ms before transmission.
This balances response time with packet stability. Scroll and button events
remain immediate. The BLE HID link uses 100 reports per second, leaving timing
margin below the 125 Hz hardware limit and reducing report contention.

## Build 2026-11-03-4 — slow-speed stutter

Symptom: during a slow drag the cursor moved, stopped, moved, stopped. Fast
drags felt fine.

### Root cause: two random delays per delta

Every pointer sample waited for two independent clocks:

1. the firmware's own 8 ms staging timer (`0–8 ms`), then
2. the HID library's 7 ms report task (`0–7 ms`).

So each delta reached the Mac after a random **0–15 ms**. At slow speed the
phone emits roughly one unit per display frame (16.7 ms). Adding a random
0–15 ms to a 16.7 ms cadence produces delivered gaps anywhere from ~2 ms to
~31 ms — a 2-frame hole is visible as "stop, then jump". At high speed the
deltas are large, so the same time error is invisible against the motion.

### Fixes

- **Movement is delivered on arrival.** `handleWebSocket()` calls
  `flushMovement()` as soon as an `M` packet is parsed. An 8 ms guard
  (`MOVE_GUARD_MS`) still protects against the library's overwrite semantics:
  it only delays a write while the previous write has not yet been consumed.
  Normal 60/120 Hz input never waits; only bursts do. This removes the entire
  staging stage, halving worst-case delivery jitter to the BLE connection
  interval (7.5 ms, the hardware floor).
- **HTTP polling removed.** The page no longer fetches `/status` every 2 s.
  The firmware pushes `B 0` / `B 1` over the existing WebSocket when the BLE
  state changes, and sends it to each client on connect. `/status` is kept
  for manual diagnostics. No periodic HTTP connection can block the loop
  during a gesture.
- **Wi-Fi heartbeat.** The page sends `K <seq>` every 30 ms while visible.
  Sparse traffic lets an Android radio enter power save and buffer packets
  until the next beacon, which looks exactly like stop-start. The heartbeat
  keeps the radio awake and gives the firmware a fixed-cadence signal.
- **Gap instrumentation.** The firmware reports the worst/mean arrival gap of
  the heartbeat and the longest main-loop stall in the `P` reply. The page
  also tracks the gap between real pointer samples. The status pill now shows
  `· TOUCH <max>` when touch delivery stalls (>30 ms), `· LINK <max>` when
  the Wi-Fi path stalls (>120 ms), and `· BUSY` when movement queues up on
  the ESP32. Hovering/long-press shows full stats in the `title`.

### Why 7.5 ms is the floor

BLE connection interval minimum is 7.5 ms. Once a delta is written to the
library, the link layer can deliver it at the next connection event. No
firmware change can beat that. If the pill stays clean and the cursor still
stutters, the remaining jitter is BLE/macOS scheduling, and the only cure is
USB HID on an ESP32-S3 (this board has no USB device controller).

### Verification

- `node tests/gesture-smoke-test.js` — 16/16 pass (3 new: BLE push, link
  diagnostics, heartbeat)
- Embedded HTML/CSS/JS match the editable sources
- `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app` —
  pass (1,237,699 bytes, 39% flash; 59,260 bytes, 18% RAM)
- Flashed; `esptool verify_flash` digest matched

## Build 2026-11-03-3 — latency instrumentation and retuned momentum

### 1. Link latency measurement

The phone sends `P <seq>` over the WebSocket every 1.5 s; the firmware echoes
`P <seq> <backlog>`, where `backlog` is the number of whole ±127 movement
reports still queued on the ESP32. The phone shows the smoothed round-trip
time in the status pill:

- `PHONE CONNECTED · 18 ms` — healthy.
- `PHONE CONNECTED · 84 ms` — Wi-Fi hop is the problem.
- `PHONE CONNECTED · 18 ms ±35` — high jitter.
- `PHONE CONNECTED · 18 ms · BUSY` — the ESP32 is more than two reports
  behind; the bottleneck is the BLE side, not the phone.

The pill turns amber (`data-state="warn"`) when RTT > 60 ms, jitter > 20 ms,
or the firmware backlog ≥ 3 reports. This makes the lag measurable instead
of guessed.

### 2. Actual latency removed (no prediction)

- **Raw touch samples.** `pointerrawupdate` is handled in addition to
  `pointermove`. Chrome can deliver touch samples before they are coalesced
  into a display frame. The handler measures movement from the last stored
  position, so a duplicate delivery contributes zero — verified by a
  regression test.
- **BLE idle mode suppressed.** The HID library switches the link to 80 units
  of slave latency after 5 s without input, then requests the fast parameters
  again when movement resumes. That parameter-update round trip lands exactly
  when the user starts moving. While a phone is connected the firmware now
  refreshes the library's idle clock every 2 s with a zero scroll delta
  (queues no HID report), so the link stays at 7.5 ms / latency 0.
- **No HTTP in front of input.** `webSocket.loop()` now runs before
  `httpServer.handleClient()`, so a `/status` poll cannot delay a movement
  packet. The phone also skips status polling while a gesture is active.
- **Scroll queue removed.** The firmware's extra 10 ms scroll queue sat on
  top of the library's own one-tick-per-report pacing and only added delay.
  `S` values now go straight to `addScroll()`; the library still emits at
  most one wheel tick per HID report, so bursts cannot become jumps.

### 3. Momentum retuned

- The coast now uses the exact integral of the exponential decay over each
  animation frame, so the distance is identical on 60 Hz and 120 Hz displays.
- The velocity seed uses the time since the previous two-finger sample rather
  than the gesture start, so a flick that begins after the fingers rested is
  measured correctly.
- Velocity is clamped to 3 px/ms and to 0.1 wheel units/ms (below the HID
  drain rate) so the coast cannot overshoot after the animation ends.
- Decay constant 400 ms, hard stop 2.6 s, stop threshold 0.015 px/ms.

### Why there is no "AI" / predictive cursor

Predicting the cursor forward by the measured lag requires sending a position
that is ahead of the finger. When the finger stops, that lead has to go
somewhere: either the cursor overshoots by `velocity × lead` (tens of pixels
on a fast flick) or it visibly snaps back. Both are worse than the lag for a
pointing device, and a learned model cannot avoid the physics — it just hides
the error statistically. So this build measures the lag and removes real
latency; it does not fake forward motion. If the RTT readout shows the Wi-Fi
hop is the dominant term, the next step is a link fix, not a predictor.

### Verification

- `node tests/gesture-smoke-test.js` — 13/13 pass
- Embedded HTML/CSS/JS match the editable sources
- `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app` —
  pass (1,233,963 bytes, 39% flash; 59,220 bytes, 18% RAM)

## Build 2026-11-03-2 — cache and latency

Reference copy of the earlier notes follows.

## Cache fix

The phone kept the old page open across the ESP32 reboot, so it continued
running the previous HTML/JS. The web server now sends `no-store` cache
headers for `/`, `/style.css`, `/app.js`, and `/status`, and the page
references `/style.css?v=2` and `/app.js?v=2`. The footer shows
`BUILD 2026-11-03-2` so it is obvious which page is loaded.

## Latency change

Pointer deltas are now sent immediately on each `pointermove` instead of
waiting for a 10 ms timer. The firmware still accumulates them, so sending
more often cannot drop movement. The firmware drain is now 8 ms (just above
the 7 ms HID report interval).

This supersedes the movement/scroll sections of
`docs/phase-2-4-changes.md`, which describe the previous acceleration and
precision-scroll behaviour.

## Backups

Pre-change files are in `backups/20261103-194224-drag-scroll/`.

## Frontend

- Removed the on-screen LEFT / RIGHT / MIDDLE button row.
- Removed all software pointer acceleration. Pointer speed is now exactly the
  value of the slider (`M` delta = finger delta × sensitivity).
- Movement is sent immediately on each pointer sample, and sub-pixel
  remainders are preserved. Large deltas are not split into ±127 chunks on
  the phone; the firmware owns chunking.
- Two-finger scrolling:
  - no precision-hold mode;
  - no dead-zone discard — the movement that selects the scroll axis is
    applied immediately;
  - lower axis threshold (6 px);
  - lower base gain (0.025 wheel units per px) so content tracks the finger
    instead of jumping;
  - natural mode sends the opposite wheel sign so content follows the finger.
- Hold one finger still for 400 ms to latch the left button and drag. Moving
  more than 6 px before the timer cancels the hold. Lifting the finger
  releases the button. A second finger cancels the drag and switches to
  two-finger scroll.
- Haptics: added a distinct pulse when hold-to-drag latches.

## Firmware

`ESP3D_Controller.ino` now accumulates incoming `M` deltas in `int32_t`
values and drains up to ±127 per axis every 9 ms. The BLE HID task reports
every 7 ms, so each drained delta gets its own HID report and is never
overwritten by a Wi-Fi burst.

Scroll is accumulated separately and drained as **one wheel tick at a time**
every 10 ms. This prevents a burst from becoming a single large jump, which
is what made scrolling look accelerated.

Pending movement and scroll are cleared when the WebSocket disconnects or the
BLE link is not paired. The existing 10 s held-button timeout is unchanged.

## Momentum scrolling

After a two-finger vertical swipe is released, the frontend keeps feeding
decaying scroll deltas for up to ~2.8 s (`requestAnimationFrame`,
exponential decay with a 420 ms time constant), so the page coasts and
gradually halts like a MacBook trackpad. Velocity is measured from the last
100 ms of finger movement; a pause before lifting produces no coast. Any new
touch stops momentum immediately. Starting velocity is clamped in wheel
units so it cannot outrun the firmware's one-tick-at-a-time pacing.

## Verification

- `node --check phone-app/js/app.js` — pass
- `node --check tests/gesture-smoke-test.js` — pass
- `node tests/gesture-smoke-test.js` — 12/12 pass
- `web_ui.h` regenerated; embedded copies match the sources
- `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app` —
  pass (1,226,131 bytes, 38% flash; 59,220 bytes, 18% RAM)

## Phone test checklist

1. Tap once → left click.
2. Hold still ~0.3 s, then move → left-button drag; lift to drop.
3. Move before the hold timer fires → normal cursor movement, no drag.
4. Fast cursor movement should not stutter or trail.
5. Two-finger drag down → content should move down with the fingers.
6. Flick two fingers and release → content should coast and gradually stop.
   Touching the pad during the coast must stop it immediately.
7. If scroll direction is still inverted, toggle "Natural scrolling" and
   report the result.
8. Two-finger tap → right click; three-finger tap → middle click.

Horizontal scrolling is still disabled until the firmware gains an `H`
command (see `docs/firmware-horizontal-scroll-proposal.md`).
