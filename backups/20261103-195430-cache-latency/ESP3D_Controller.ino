#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <HijelHID_BLEMouse.h>
#include <ctype.h>
#include <errno.h>
#include <stdlib.h>
#include "web_ui.h"

const char* AP_SSID = "ESP3D_Controller";
const char* AP_PASSWORD = "ESP3D-1234";

WebServer httpServer(80);
WebSocketsServer webSocket(81);
HijelBLEMouse mouse("ESP3D", "ESP3D Project", 100, 5, true);

uint8_t heldButtons = 0;
uint32_t lastButtonActivity = 0;
const uint32_t BUTTON_TIMEOUT_MS = 10000;

/* Incoming deltas are accumulated and drained at a fixed cadence. This keeps
   the BLE HID report stream stable even when Wi-Fi delivers a burst, and it
   means the phone never has to pace itself below the 125 Hz report rate. */
int32_t pendingMoveX = 0;
int32_t pendingMoveY = 0;
int32_t pendingScroll = 0;

uint32_t lastMoveDrain = 0;
uint32_t lastScrollDrain = 0;

const uint32_t MOVE_DRAIN_MS = 9;    /* just above the 7 ms HID report interval */
const uint32_t SCROLL_DRAIN_MS = 10;
const int32_t MOVE_ACCUM_LIMIT = 2000;
const int32_t SCROLL_ACCUM_LIMIT = 6;

bool readNumber(const char*& p, long& value) {
  while (*p && isspace((unsigned char)*p)) p++;

  errno = 0;
  char* end;
  value = strtol(p, &end, 10);

  if (end == p || errno == ERANGE) return false;

  p = end;
  return true;
}

bool commandFinished(const char* p) {
  while (*p && isspace((unsigned char)*p)) p++;
  return *p == '\0';
}

void releaseAllButtons() {
  mouse.releaseAll();
  heldButtons = 0;
}

void clearPendingInput() {
  pendingMoveX = 0;
  pendingMoveY = 0;
  pendingScroll = 0;
}

void drainMovement(uint32_t now) {
  if (pendingMoveX == 0 && pendingMoveY == 0) return;
  if (now - lastMoveDrain < MOVE_DRAIN_MS) return;

  lastMoveDrain = now;

  if (!mouse.isConnected() || !mouse.isPaired()) {
    pendingMoveX = 0;
    pendingMoveY = 0;
    return;
  }

  int16_t dx = (int16_t)constrain(pendingMoveX, -127L, 127L);
  int16_t dy = (int16_t)constrain(pendingMoveY, -127L, 127L);

  pendingMoveX -= dx;
  pendingMoveY -= dy;

  mouse.move(dx, dy);
}

void drainScroll(uint32_t now) {
  if (pendingScroll == 0) return;
  if (now - lastScrollDrain < SCROLL_DRAIN_MS) return;

  lastScrollDrain = now;

  if (!mouse.isConnected() || !mouse.isPaired()) {
    pendingScroll = 0;
    return;
  }

  /* One wheel tick at a time — never stack a burst into one report, which
     is what made scrolling look accelerated. */
  int8_t step = pendingScroll > 0 ? 1 : -1;
  pendingScroll -= step;
  mouse.addScroll(step);
}

void handleWebSocket(uint8_t client, WStype_t type,
                     uint8_t* payload, size_t length) {

  if (type == WStype_DISCONNECTED) {
    releaseAllButtons();
    clearPendingInput();
    return;
  }

  if (type != WStype_TEXT || length == 0 || length > 40) return;

  char message[41];
  memcpy(message, payload, length);
  message[length] = '\0';

  const char* p = message;
  long a, b;

  if (message[0] == 'M' &&
      isspace((unsigned char)message[1])) {

    p++;
    if (!readNumber(p, a) || !readNumber(p, b)) return;
    if (!commandFinished(p)) return;

    if (!mouse.isConnected()) return;

    if (a < -32768 || a > 32767 ||
        b < -32768 || b > 32767) return;

    pendingMoveX = constrain(
      pendingMoveX + (int32_t)a, -MOVE_ACCUM_LIMIT, MOVE_ACCUM_LIMIT
    );
    pendingMoveY = constrain(
      pendingMoveY + (int32_t)b, -MOVE_ACCUM_LIMIT, MOVE_ACCUM_LIMIT
    );
  }

  else if (message[0] == 'B' &&
           isspace((unsigned char)message[1])) {

    p++;
    while (*p && isspace((unsigned char)*p)) p++;

    char button = *p++;
    if (!button || !isspace((unsigned char)*p)) return;

    if (!readNumber(p, a) || !commandFinished(p)) return;
    if (a != 0 && a != 1) return;
    if (!mouse.isConnected()) return;

    MouseButton selectedButton;
    uint8_t buttonMask;

    if (button == 'L') {
      selectedButton = MouseButton::Left;
      buttonMask = 1;
    }
    else if (button == 'R') {
      selectedButton = MouseButton::Right;
      buttonMask = 2;
    }
    else if (button == 'M') {
      selectedButton = MouseButton::Middle;
      buttonMask = 4;
    }
    else {
      return;
    }

    mouse.setButton(selectedButton, a == 1);

    if (a == 1) heldButtons |= buttonMask;
    else heldButtons &= ~buttonMask;

    lastButtonActivity = millis();
  }

  else if (message[0] == 'S' &&
           isspace((unsigned char)message[1])) {

    p++;
    if (!readNumber(p, a) || !commandFinished(p)) return;
    if (a < -127 || a > 127) return;

    if (mouse.isConnected()) {
      pendingScroll = constrain(
        pendingScroll + (int32_t)a, -SCROLL_ACCUM_LIMIT, SCROLL_ACCUM_LIMIT
      );
    }
  }
}

void setup() {
  Serial.begin(115200);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD, 1, false, 1);

  httpServer.on("/", HTTP_GET, []() {
    httpServer.send_P(200, "text/html", INDEX_HTML);
  });

  httpServer.on("/style.css", HTTP_GET, []() {
    httpServer.send_P(200, "text/css", STYLE_CSS);
  });

  httpServer.on("/app.js", HTTP_GET, []() {
    httpServer.send_P(200, "application/javascript", APP_JS);
  });

  httpServer.on("/status", HTTP_GET, []() {
    String result = "{\"ble\":";
    result += mouse.isConnected() ? "true" : "false";
    result += ",\"wifiClients\":";
    result += String(WiFi.softAPgetStationNum());
    result += "}";

    httpServer.send(200, "application/json", result);
  });

  httpServer.begin();

  mouse.setLogLevel(HIDLogLevel::Normal);
  mouse.setUpdateRate(HIDRate::Hz125);
  mouse.begin();

  webSocket.begin();
  webSocket.onEvent(handleWebSocket);

  Serial.println("ESP3D ready");
  Serial.println("Wi-Fi: ESP3D_Controller");
  Serial.println("Password: ESP3D-1234");
  Serial.println("Open: http://192.168.4.1");
}

void loop() {
  httpServer.handleClient();
  webSocket.loop();

  uint32_t now = millis();
  drainMovement(now);
  drainScroll(now);

  if (heldButtons != 0 &&
      millis() - lastButtonActivity >= BUTTON_TIMEOUT_MS) {
    releaseAllButtons();
  }

  delay(1);
}
