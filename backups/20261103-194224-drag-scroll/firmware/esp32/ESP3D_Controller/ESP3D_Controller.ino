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

void handleWebSocket(uint8_t client, WStype_t type,
                     uint8_t* payload, size_t length) {

  if (type == WStype_DISCONNECTED) {
    releaseAllButtons();
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

    mouse.move(
      constrain((int)a, -127, 127),
      constrain((int)b, -127, 127)
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
    if (a < -10 || a > 10) return;

    if (mouse.isConnected()) {
      mouse.addScroll((int8_t)a);
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

  if (heldButtons != 0 &&
      millis() - lastButtonActivity >= BUTTON_TIMEOUT_MS) {
    releaseAllButtons();
  }

  delay(1);
}
