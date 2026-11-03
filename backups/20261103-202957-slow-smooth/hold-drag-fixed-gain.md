# Hold-to-drag, fixed gain, and firmware delta accumulation

Date: 2026-11-03
Status: build 2026-11-03-3 flashed 2026-11-03 (upload hash verified, flash
digest verified against the file, boot log clean, BLE reconnected).

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
