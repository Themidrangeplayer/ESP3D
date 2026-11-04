/*
 * Android-only bridge. This file is copied into the APK assets at build time
 * and loaded immediately before js/app.js. It is never served by the ESP32,
 * so the browser version of the controller is unaffected.
 */
(function () {
  'use strict';

  /* The bundled page has an appassets.androidplatform.net origin. Route the
     controller's WebSocket through the in-app loopback proxy, which pins the
     upstream connection to the ESP32 Wi-Fi network. */
  if (!window.ESP3D_WS_URL) {
    window.ESP3D_WS_URL = 'ws://127.0.0.1:8081/';
  }

  /* Android WebView's navigator.vibrate is unreliable and is sometimes not
     exposed at all. Replace it before app.js evaluates hapticsSupported. */
  if (window.Esp3dAndroid && typeof window.Esp3dAndroid.vibrate === 'function') {
    var nativeVibrate = function (pattern) {
      try {
        window.Esp3dAndroid.vibrate(JSON.stringify(pattern));
        return true;
      } catch (error) {
        return false;
      }
    };

    try {
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        writable: true,
        value: nativeVibrate
      });
    } catch (error) {
      try {
        navigator.vibrate = nativeVibrate;
      } catch (ignored) {
        /* leave the browser implementation in place */
      }
    }
  }

  /* Keep the header clear of a display cutout while the system bars are
     hidden. Browsers that do not support env() ignore the declaration. */
  var style = document.createElement('style');
  style.textContent =
    'header{padding-top:calc(22px + env(safe-area-inset-top, 0px));}';
  document.head.appendChild(style);
})();
