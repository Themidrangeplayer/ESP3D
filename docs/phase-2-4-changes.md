# Phase 2–4 changes (frontend only)

> Superseded for movement and scrolling by
> `docs/hold-drag-fixed-gain.md` (2026-11-03): pointer acceleration,
> precision scrolling, and the on-screen buttons have been removed. This file
> remains as the record of the earlier phase.

Date: 2026-11-03
Firmware logic: **unchanged**. `web_ui.h` was regenerated and the sketch was
compiled, but **nothing was flashed**.

## Backups

The pre-change files are in `backups/20261103-192240/`:

- `index.html`
- `style.css`
- `app.js`
- `web_ui.h`
- `generate_web_header.py`

## 1. CSS contamination fixed

`phone-app/css/style.css` contained a literal `</EOF>` at line 43 followed by
a shell heredoc and a duplicate copy of the old `app.js`. That garbage had
also been embedded into `web_ui.h`. The CSS is now a clean stylesheet.
`generate_web_header.py` now refuses to embed a file containing `</EOF>`,
`<<'EOF'`, or the raw-string delimiter.

## 2. Why the cursor was jerky

From `HijelHID_BLEMouse.cpp`:

```cpp
void HijelBLEMouse::move(int16_t dx, int16_t dy) {
    int8_t cx = _clampInt8(dx);
    int8_t cy = _clampInt8(dy);
    ...
    _state.x = cx;
    _state.y = cy;
}
```

`move()` **overwrites** the pending delta. A 125 Hz task samples and clears
it. The old phone code sent one message per `pointermove`, which on Android
can exceed 125 Hz. Any two messages inside one 8 ms BLE window meant the
first delta was silently discarded — visible as lag/judder during fast
movement.

The frontend now coalesces all pointer movement and flushes at most once per
12 ms (≈83 Hz), leaving margin for Wi-Fi jitter. Every delta is preserved:

- raw travel accumulates between flushes;
- output is split into chunks of at most ±127 per axis (the firmware's HID
  limit), with any excess carried to the next flush;
- sub-pixel remainders carry across flushes, so slow motion is not lost;
- a stalled link keeps a short burst but discards input older than 180 ms
  instead of replaying a large stale jump.

Adaptive acceleration is a smoothstep curve: 1:1 at slow speed for precision,
up to 1.9× at high speed. It multiplies the user sensitivity setting.

## 3. Gestures

| Gesture | Result |
|---|---|
| 1 finger move | cursor movement |
| 1 finger tap | left click |
| 2 finger vertical drag | `S` scroll (natural direction by default) |
| 2 finger horizontal drag | no-op; shows "H-SCROLL UNAVAILABLE" |
| 2 finger tap | right click |
| 3 finger tap | middle click |
| 2 finger hold ≥260 ms then drag | precision scroll (0.4×) |

Tap limits: ≤320 ms total, ≤300 ms between the first and last finger landing,
and ≤10 px of travel per finger. Scroll axis locks after 9 px to prevent
diagonal jitter. Lifting one of two fingers stops scrolling and does not
resume cursor movement.

Clicks hold the button for 24 ms so at least one 125 Hz HID report sees the
press. Pad taps are suppressed while a physical on-screen button is held.

## 4. Haptics

- separate patterns for left/right/middle click;
- gentle pulse when a scroll gesture is recognised;
- optional connection/disconnection alerts (off by default);
- enable/disable, 0.4×–2× intensity, and a test button;
- `navigator.vibrate` is feature-detected; absence shows a note and disables
  the test button.

Android Chrome only. Vibration may be ignored by the browser/OS depending on
device, power-saving mode, and whether the page has had user interaction.

## 5. UI

- dark hardware-style layout with status pills and a larger touchpad;
- scroll UP/DOWN buttons removed;
- pointer speed, scroll speed, natural scrolling, haptics, haptic intensity,
  and connection alerts;
- settings persist in `localStorage`;
- gestures show a short text confirmation on the pad.

## Test steps

0. Optional headless regression test (no hardware needed):

   ```bash
   node tests/gesture-smoke-test.js
   ```

1. Recompile and flash only after explicit approval (not done here).
2. Connect the phone to `ESP3D_Controller` and open `http://192.168.4.1`.
3. Verify both pills: `PHONE CONNECTED` and `BLE: CONNECTED`.
4. One finger: slow movement should be precise, fast movement should not
   stutter or trail.
5. Tap once → left click; verify a click, not a drag.
6. Two-finger drag up/down → scroll. Toggle "Natural scrolling" if the
   direction feels inverted.
7. Two-finger tap → right click; three-finger tap → middle click.
8. Hold two fingers still for ~0.3 s, then drag → slower precision scroll.
9. Enable/disable haptics and change intensity; each tap should feel
   different. Use "TEST HAPTICS" to check device support.
10. Press and hold an on-screen button, then tap the pad: the tap must be
    ignored (no stuck button).
11. Background the browser or lock the phone while holding a button: the
    button must release.

## Known limitations / next steps

- Horizontal scroll needs the firmware `H` command described in
  `docs/firmware-horizontal-scroll-proposal.md`.
- Some Android shells reserve three-finger gestures; test that middle click
  reaches the page. If not, an alternative gesture can be added.
- Pointer capture and vibration support vary by browser; Chrome for Android
  is the target.
- Real-device latency/jitter has not been measured yet. If it still feels
  unstable, the next step is to measure round-trip timing rather than adding
  more smoothing.
