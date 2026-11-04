# ESP3D Android

A full-screen Android shell for the existing ESP3D phone controller. The APK
bundles `../phone-app/`, serves it from a private asset origin, and tunnels the
controller WebSocket to the ESP32 through a loopback TCP proxy bound to the
ESP32 Wi-Fi network.

The browser version in `../phone-app/` is still the single source of truth for
the UI, gestures, settings, and haptics.

## Requirements

- A full JDK 21 (not a JRE-only install). The build asks Gradle for a JDK 21
  toolchain, so you do not need to export `JAVA_HOME`. If Gradle cannot find
  one, install Temurin 21 or set `org.gradle.java.home`.
- Android SDK Platform 35 and Build Tools 35.0.0
- A phone running Android 8.0 (API 26) or newer

The Gradle wrapper downloads Gradle 8.13 on first use and verifies its
SHA-256 checksum.

## Build

```sh
cd android-app
./gradlew assembleDebug
```

The APK is at:

```text
app/build/outputs/apk/debug/app-debug.apk
```

Install it on a connected phone:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

For a release build, use `./gradlew assembleRelease`. The release build is not
signed; add your own signing config before distributing it.

## How it works

### Bundled UI, no PWA

The ESP32 serves plain HTTP and `ws://`, so a Trusted Web Activity or an
installable PWA is not a fit. The app uses one full-screen `WebView` and
`WebViewAssetLoader` to serve the copied web files from:

```text
http://appassets.androidplatform.net/assets/www/index.html
```

`http` is used deliberately: an `https` asset origin would make the `ws://`
controller link mixed content. The origin is private to the app, and cleartext
is allowed only for the asset domain, loopback, and `192.168.4.1`.

### One build-time transform

`prepareWebAssets` copies `../phone-app/` into generated assets and inserts:

```html
<script src="js/native-bridge.js"></script>
```

immediately before `js/app.js`. `native-bridge.js` does three Android-only
things:

1. Sets `window.ESP3D_WS_URL = "ws://127.0.0.1:8081/"`.
2. Replaces `navigator.vibrate` with the native haptics bridge.
3. Adds top safe-area padding for display cutouts.

The only change in the shared web source is one backward-compatible guard at the
top of `socketUrl()`:

```js
if (window.ESP3D_WS_URL) return window.ESP3D_WS_URL;
```

In a normal browser the global is absent, so the existing behavior is unchanged.
If the shared web source changes, regenerate the embedded copy used by the
firmware:

```sh
cd ..
python3 generate_web_header.py
```

### Loopback WebSocket proxy

The WebSocket never goes through WebView's network stack directly.

```text
WebView  ws://127.0.0.1:8081/
             |
             v
     LoopbackProxy (app process, 127.0.0.1 only)
             |
             v  Network.getSocketFactory()
     192.168.4.1:81  (ESP32)
```

- The listener binds to `127.0.0.1:8081` only.
- Each accepted socket is connected upstream through the `SocketFactory` of the
  `Network` that belongs to `192.168.4.0/24`, so it cannot fall back to cellular.
- `TCP_NODELAY` is set on both legs.
- The proxy is a byte pump; the WebSocket handshake and framing are untouched.

### Wi-Fi

`EspNetworkManager` identifies the ESP32 network from `LinkProperties`: a Wi-Fi
transport whose gateway is `192.168.4.1` or whose address is in
`192.168.4.0/24`. This does not require reading the SSID or location access.

If the phone is not already on the ESP32 AP, the native screen offers:

- **CONNECT** — Android 10+ `WifiNetworkSpecifier` for `ESP3D_Controller`
  (WPA2, password `ESP3D-1234`). Android shows its own approval prompt, then the
  app keeps the app-scoped, local-only network for the activity lifetime.
- **WI-FI SETTINGS** — opens the system Wi-Fi panel so the user can join the AP
  manually. The network watcher then detects it automatically.

Android 9 and older have no `WifiNetworkSpecifier`; the Wi-Fi settings button is
the path there. The network watcher still detects a manually joined AP.

### Permissions

| Permission | Why |
| --- | --- |
| `INTERNET` | Loopback proxy and the ESP32 link |
| `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE` | Find and bind the ESP32 network |
| `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE` | Wi-Fi request and link inspection |
| `ACCESS_FINE_LOCATION` (API 29-32 only) | Required by Android to join Wi-Fi from an app |
| `NEARBY_WIFI_DEVICES` (API 33+, neverForLocation) | Replacement for location on newer Android |
| `VIBRATE` | Native haptic bridge |

The app requests the Wi-Fi permission only when the user taps **CONNECT**.

### Full-screen behavior

- Portrait locked; the status and navigation bars are hidden with transient
  swipe-to-reveal behavior.
- Screen stays on while the activity is resumed.
- Zoom, scrollbars, overscroll, text selection, long-press menus, and external
  navigation are disabled.
- Back releases any held mouse button and moves the task to the background.
- `onPause` and WebView `visibilitychange` both release held buttons.

### Haptics

`navigator.vibrate` is unreliable in Android WebView, so the bundled page uses
`Esp3dAndroid.vibrate(...)` through a `@JavascriptInterface`. The bridge parses
the same number-or-array pattern that `app.js` already produces, keeps the
pauses, and uses `VibrationEffect.createWaveform`.

## Configuration

The AP credentials and protocol live in `EspNetworkManager.kt`:

```kotlin
const val AP_SSID = "ESP3D_Controller"
const val AP_PASSWORD = "ESP3D-1234"
const val ESP_HOST = "192.168.4.1"
```

The WebSocket upstream port is `81` and is set in `LoopbackProxy`.

Do not change the ESP32 AP credentials, HTTP routes, or WebSocket protocol from
this app. The firmware is the authority.

## Testing checklist

1. Fresh install, mobile data on, not on the AP: the native screen appears and
   offers **CONNECT** / **WI-FI SETTINGS**.
2. Join `ESP3D_Controller`: the dark controller loads full-screen.
3. One-finger move, tap = left click, ~400 ms hold + move = drag, two-finger drag
   = scroll with momentum, two-finger tap = right click, three-finger tap =
   middle click.
4. Screen stays on; system bars stay hidden; edge swipes do not refresh or scroll
   the page; long-press does not select text.
5. Haptics obey the toggle and intensity slider; settings survive an app restart.
6. Back does not leave a button pressed; relaunching reconnects.
7. Turn the ESP32 off and on: the status changes to reconnecting and recovers
   without a restart.

## Known limitations

- Android shows its own Wi-Fi approval dialog the first time **CONNECT** is
  used. This cannot be skipped for a non-system app.
- On Android 9 and older the user must join the AP from system settings.
- An app-scoped `WifiNetworkSpecifier` network is released when the activity is
  destroyed, so a cold start may need to ask again.
- Android may warn that the ESP32 network has no internet access. That is
  expected; choose **Stay connected** if the system offers the choice.
- The UI is still the WebView implementation from `phone-app/`. If cursor feel
  is not good enough, a native Kotlin touchpad is the next step; do not retune
  the web gestures without measurement.

## Files outside `android-app/`

- `phone-app/js/app.js` — added the `window.ESP3D_WS_URL` guard in `socketUrl()`.
- `firmware/esp32/ESP3D_Controller/web_ui.h` — regenerated from the web source.

No firmware behavior, AP credentials, routes, or protocol were changed.
