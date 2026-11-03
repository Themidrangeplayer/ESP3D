# ESP3D

ESP3D is a low-latency wireless mouse controller built around an ESP32. A
phone provides the touchpad through a local web interface, the ESP32 carries
input over Wi-Fi, and Bluetooth Low Energy presents the device to a computer
as a standard HID mouse.

## Features

- One-finger cursor movement with configurable pointer speed
- Tap-to-click, hold-to-drag, two-finger right-click, and three-finger
  middle-click
- Two-finger scrolling with natural-scroll direction and momentum
- Optional on-screen left, right, and middle mouse buttons
- Optional haptic feedback and connection alerts
- Monochrome, responsive phone interface with no external services
- BLE HID output using a fixed 125 Hz report rate
- FreeRTOS tasks separating network service and cursor delivery
- Safety release on disconnect, page hide, blur, and button timeout
- Embedded web assets, so the ESP32 serves the complete controller locally

## Hardware

- ESP32 development board with BLE support
- USB cable for initial flashing
- Computer with Bluetooth support
- Phone with a modern browser supporting WebSockets and Pointer Events

The default status LED is GPIO2, active high. Boards with a different LED
layout can change `STATUS_LED_PIN` and `STATUS_LED_ACTIVE_HIGH` in
`firmware/esp32/ESP3D_Controller/ESP3D_Controller.ino`.

## How it works

1. The ESP32 creates the Wi-Fi access point `ESP3D_Controller`.
2. The phone connects to that network and opens `http://192.168.4.1`.
3. The web app sends compact WebSocket commands to the ESP32.
4. The ESP32 forwards cursor, button, and scroll input through BLE HID.
5. The computer pairs with the BLE device named `ESP3D`.

The phone does not require an installed application, cloud account, internet
connection, or third-party server.

## First-time setup

### 1. Install the firmware toolchain

Install Arduino CLI and the Espressif ESP32 core. The project is tested with
Arduino ESP32 core 3.3.12 and the `HijelHID_BLEMouse` library 0.1.0.

Install the BLE mouse library from its trusted source, then select an ESP32
board matching your hardware. The controller is tested on an ESP32-D0WD-V3
using the standard `esp32:esp32:esp32` target.

### 2. Embed the web application

The editable web files are in `phone-app/`. Regenerate the firmware asset
before compiling:

```bash
python3 generate_web_header.py
```

This writes `firmware/esp32/ESP3D_Controller/web_ui.h`.

### 3. Compile and flash

```bash
arduino-cli compile \
  --fqbn esp32:esp32:esp32 \
  firmware/esp32/ESP3D_Controller

arduino-cli upload \
  --port /dev/cu.usbserial-0001 \
  --fqbn esp32:esp32:esp32 \
  firmware/esp32/ESP3D_Controller
```

Replace the serial port with the port reported by your operating system.

### 4. Connect the phone

Connect to:

- Wi-Fi network: `ESP3D_Controller`
- Wi-Fi password: `ESP3D-1234`
- Controller URL: `http://192.168.4.1`

### 5. Pair the computer

Open Bluetooth settings on the computer and pair with `ESP3D`. After the BLE
status shows connected, use the phone touchpad.

## Controls

| Gesture | Action |
| --- | --- |
| One-finger move | Move cursor |
| One-finger tap | Left click |
| One-finger hold and move | Drag |
| Two-finger tap | Right click |
| Two-finger vertical drag | Scroll |
| Three-finger tap | Middle click |

Settings are stored locally in the browser. The virtual mouse buttons are
disabled by default and can be enabled in the settings panel.

## Firmware architecture

- `network-service`: pinned to core 0; services HTTP, WebSocket, status LED,
  BLE status, keepalive, and button timeout handling.
- `hid-movement`: pinned to core 1 at the highest application priority; drains
  accumulated cursor deltas on the 125 Hz movement cadence.
- `HijelBLEMouse` report task: emits BLE HID reports at 125 Hz.

Movement state shared with the WebSocket callback is protected by an ESP32
critical-section lock. Large movement bursts are accumulated and split into
BLE-safe axis deltas rather than silently overwriting reports.

## WebSocket protocol

The phone connects to port 81. Commands are plain text:

```text
M dx dy       Cursor movement
B L 0|1       Left button release/press
B R 0|1       Right button release/press
B M 0|1       Middle button release/press
S value       Vertical scroll
```

The protocol is intentionally local and minimal. The controller does not
expose a diagnostics endpoint or require internet access.

## Repository layout

```text
firmware/esp32/ESP3D_Controller/  Production ESP32 firmware
phone-app/                       Editable web controller
generate_web_header.py            Web asset embedder
mac-companion/                    Optional macOS cursor tracing utility
docs/                             Design and historical engineering notes
VERSION                           Current release version
```

## Development checks

Regenerate the embedded web header and check JavaScript syntax before
committing:

```bash
python3 generate_web_header.py
node --check phone-app/js/app.js
arduino-cli compile --fqbn esp32:esp32:esp32 \
  firmware/esp32/ESP3D_Controller
```

Generated build directories are ignored. The embedded `web_ui.h` is committed
so a checkout contains a directly compilable firmware tree.

## Release process

Releases use semantic version tags:

```bash
git tag -a v1.0.0 -m "ESP3D v1.0.0"
git push origin v1.0.0
```

GitHub Actions validates asset generation, JavaScript syntax, and the firmware
source on every push and pull request. Release binaries should be built from
the tagged source with the board-specific Arduino CLI command above.

## License

No license has been declared yet. Until a license is added, all rights are
reserved by the copyright holder.
