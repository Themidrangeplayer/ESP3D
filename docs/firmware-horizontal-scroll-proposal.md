# Firmware proposal: horizontal scrolling (`H` command)

Status: **not applied**. The frontend ships with
`HORIZONTAL_SCROLL_ENABLED = false` and never sends `H`.

## What already works

In `ESP3D_Controller.ino` the mouse is constructed with the fifth argument
`true`:

```cpp
HijelBLEMouse mouse("ESP3D", "ESP3D Project", 100, 5, true);
```

That argument is `horizontalScroll`, so the HID report descriptor **already
exposes the AC Pan axis**. The HijelHID_BLEMouse 0.1.0 library also provides:

```cpp
void addScrollH(int8_t dz);  // negative = left, positive = right
```

No re-pairing should be needed, because the descriptor does not change.

## What is missing

`handleWebSocket()` has no command that calls `addScrollH()`. The existing
`S` handler only calls `addScroll()`. The phone therefore cannot ask for
horizontal scrolling today.

## Proposed minimal patch (needs approval + reflash)

Add this branch after the existing `S` branch in `handleWebSocket()`:

```cpp
  else if (message[0] == 'H' &&
           isspace((unsigned char)message[1])) {

    p++;
    if (!readNumber(p, a) || !commandFinished(p)) return;
    if (a < -10 || a > 10) return;

    if (mouse.isConnected()) {
      mouse.addScrollH((int8_t)a);
    }
  }
```

The parser, length limit (`length > 40`), and `-10..10` validation already
used by `S` are sufficient. No other firmware change is required.

## Enabling it on the phone

In `phone-app/js/app.js`:

```js
const HORIZONTAL_SCROLL_ENABLED = false;  // change to true after flashing
```

Then regenerate `web_ui.h`, recompile, and flash.

## Why it was not enabled pre-emptively

Sending `H` to the current firmware is silently ignored. Leaving the flag
off keeps the UI honest: a horizontal two-finger drag currently shows
"H-SCROLL UNAVAILABLE" instead of pretending to scroll.

## Optional, unrelated: `delay(1)` in `loop()`

`loop()` ends with `delay(1)`. This is not believed to be the main cause of
the jerky cursor (the larger issue was input arriving faster than the 125 Hz
HID report rate, which overwrites the library's pending delta). Do not change
it until the new batching has been tested on hardware. If WebSocket latency
still looks high afterwards, try `delay(0)` or `yield()` as a separate,
measured change.
