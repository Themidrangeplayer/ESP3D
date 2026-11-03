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

/* Incoming movement is accumulated and drained at a fixed cadence. The HID
   library overwrites its pending delta on every move() call, so the drain
   period must stay above the 7 ms report interval or movement is lost. */
int32_t pendingMoveX = 0;
int32_t pendingMoveY = 0;

uint32_t lastMoveDrain = 0;

const uint32_t MOVE_DRAIN_MS = 8;    /* just above the 7 ms HID report interval */
const int32_t MOVE_ACCUM_LIMIT = 2000;

/* The library refreshes its idle timer on addScroll(), and after 5 s without
   input it switches the BLE link to 80 units of slave latency. Requesting the
   fast connection parameters again costs a parameter-update round trip right
   when the user starts moving. Touching the idle clock keeps the link at the
   low-latency settings while a phone is connected. addScroll(0) queues no
   HID report. */
uint32_t lastKeepAlive = 0;
const uint32_t KEEP_ALIVE_MS = 2000;

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
}

void keepBleLinkActive(uint32_t now) {
  if (now - lastKeepAlive < KEEP_ALIVE_MS) return;
  lastKeepAlive = now;

  if (webSocket.connectedClients() == 0) return;
  if (!mouse.isConnected() || !mouse.isPaired()) return;

  /* Zero delta: refreshes the library idle clock without emitting a report. */
  mouse.addScroll(0);
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
    if (a < -32 || a > 32) return;

    if (mouse.isConnected()) {
      /* addScroll() accumulates; the HID task emits one tick per report, so a
         burst can never arrive as a single jump. This replaced a second
         firmware queue that only added delay on top of the library's own
         one-tick-per-report pacing. */
      mouse.addScroll((int8_t)a);
    }
  }

  else if (message[0] == 'P' &&
           isspace((unsigned char)message[1])) {

    /* Latency probe: echo the sequence number plus the movement backlog in
       whole ±127 reports, so the phone can tell whether the ESP32 itself is
       queueing movement. */
    p++;
    if (!readNumber(p, a) || !commandFinished(p)) return;

    int32_t backlog = pendingMoveX < 0 ? -pendingMoveX : pendingMoveX;
    int32_t backlogY = pendingMoveY < 0 ? -pendingMoveY : pendingMoveY;
    if (backlogY > backlog) backlog = backlogY;

    char reply[24];
    snprintf(reply, sizeof(reply), "P %ld %ld", a, (backlog + 126) / 127);
    webSocket.sendTXT(client, reply);
  }
}

void disableHttpCache() {
  httpServer.sendHeader(
    "Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"
  );
  httpServer.sendHeader("Pragma", "no-cache");
  httpServer.sendHeader("Expires", "0");
}

void setup() {
  Serial.begin(115200);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD, 1, false, 1);

  httpServer.on("/", HTTP_GET, []() {
    disableHttpCache();
    httpServer.send_P(200, "text/html", INDEX_HTML);
  });

  httpServer.on("/style.css", HTTP_GET, []() {
    disableHttpCache();
    httpServer.send_P(200, "text/css", STYLE_CSS);
  });

  httpServer.on("/app.js", HTTP_GET, []() {
    disableHttpCache();
    httpServer.send_P(200, "application/javascript", APP_JS);
  });

  httpServer.on("/status", HTTP_GET, []() {
    disableHttpCache();
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
  /* Serve the input socket before HTTP: a status poll must never sit in
     front of a movement packet. */
  webSocket.loop();
  httpServer.handleClient();

  uint32_t now = millis();
  drainMovement(now);
  keepBleLinkActive(now);

  if (heldButtons != 0 &&
      millis() - lastButtonActivity >= BUTTON_TIMEOUT_MS) {
    releaseAllButtons();
  }

  delay(1);
}
