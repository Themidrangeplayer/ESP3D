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

/* The HID library's move() replaces its pending report delta. Movement is
   therefore drained once per matching 8 ms report interval, rather than
   immediately on WebSocket arrival. This prevents a second write from
   overwriting the report task's pending delta and keeps delivery cadence
   stable. */
int32_t pendingMoveX = 0;
int32_t pendingMoveY = 0;

uint32_t lastMoveDrain = 0;

const uint32_t MOVE_DRAIN_MS = 8;    /* matches HIDRate::Hz125 */
const int32_t MOVE_ACCUM_LIMIT = 2000;

/* Delivery diagnostics.

   The phone sends K <seq> at a fixed 30 ms cadence. The gap between two K
   packets seen here therefore measures the phone timer plus the whole Wi-Fi
   path. loopMaxMs records the longest stall of this main loop, which catches
   HTTP or BLE stack blocking. Both are reported in the P reply and reset on
   every probe, so the phone can show the worst case since the previous one. */
uint32_t lastHeartbeatAt = 0;
uint32_t heartbeatGapSum = 0;
uint32_t heartbeatGapMax = 0;
uint32_t heartbeatCount = 0;
uint32_t lastLoopAt = 0;
uint32_t loopMaxMs = 0;

int lastBleState = -1;

/* The library refreshes its idle timer on addScroll(), and after 5 s without
   input it switches the BLE link to 80 units of slave latency. Requesting the
   fast connection parameters again costs a parameter-update round trip right
   when the user starts moving. Touching the idle clock keeps the link at the
   low-latency settings while a phone is connected. addScroll(0) queues no
   HID report. */
uint32_t lastKeepAlive = 0;
const uint32_t KEEP_ALIVE_MS = 2000;

/* Onboard status LED.

   Most ESP32 dev boards wire a blue LED to GPIO2. If yours is on another pin
   or is wired the other way round, change these two constants.

   Patterns (updated from loop(), never blocking):
     1 Hz blink         no phone connected
     4 Hz blink         phone connected, BLE not connected yet
     double pulse / 2 s ready (phone + BLE)
     solid              input is flowing (movement, buttons, scroll)      */
const uint8_t STATUS_LED_PIN = 2;
const bool STATUS_LED_ACTIVE_HIGH = true;

uint32_t ledLastToggle = 0;
uint32_t ledPulseAt = 0;
uint32_t ledActivityUntil = 0;
uint8_t ledPulseStep = 0;
uint8_t ledMode = 255;
bool ledLevel = false;

void setStatusLed(bool on) {
  if (on == ledLevel) return;
  ledLevel = on;
  digitalWrite(STATUS_LED_PIN,
               (on == STATUS_LED_ACTIVE_HIGH) ? HIGH : LOW);
}

/* Called for every accepted input packet: the LED lights while the user is
   actually controlling something. */
void ledActivity(uint32_t now) {
  ledActivityUntil = now + 15;
}

uint8_t currentLedMode() {
  bool phone = webSocket.connectedClients() > 0;
  bool ble = mouse.isConnected() && mouse.isPaired();

  if (!phone) return 0;
  if (!ble) return 1;
  return 2;
}

void updateStatusLed(uint32_t now) {
  uint8_t mode = currentLedMode();

  if (mode != ledMode) {
    ledMode = mode;
    ledLastToggle = now;
    ledPulseAt = now;
    ledPulseStep = 0;
    setStatusLed(false);
  }

  /* Input activity wins over the idle pattern. */
  if ((int32_t)(now - ledActivityUntil) < 0) {
    setStatusLed(true);
    return;
  }

  if (mode == 0) {
    if (now - ledLastToggle >= 500) {
      ledLastToggle = now;
      setStatusLed(!ledLevel);
    }
    return;
  }

  if (mode == 1) {
    if (now - ledLastToggle >= 125) {
      ledLastToggle = now;
      setStatusLed(!ledLevel);
    }
    return;
  }

  /* Ready: two short pulses, then a long pause. */
  uint32_t elapsed = now - ledPulseAt;

  switch (ledPulseStep) {
    case 0:
      if (elapsed >= 2000) {
        ledPulseAt = now; ledPulseStep = 1; setStatusLed(true);
      }
      break;
    case 1:
      if (elapsed >= 40) {
        ledPulseAt = now; ledPulseStep = 2; setStatusLed(false);
      }
      break;
    case 2:
      if (elapsed >= 120) {
        ledPulseAt = now; ledPulseStep = 3; setStatusLed(true);
      }
      break;
    default:
      if (elapsed >= 40) {
        ledPulseAt = now; ledPulseStep = 0; setStatusLed(false);
      }
      break;
  }
}

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
  lastMoveDrain = 0;
}

void noteHeartbeat(uint32_t now) {
  if (lastHeartbeatAt != 0) {
    uint32_t gap = now - lastHeartbeatAt;
    /* Ignore a gap across a page reload or a suspended phone. */
    if (gap < 5000) {
      heartbeatGapSum += gap;
      if (gap > heartbeatGapMax) heartbeatGapMax = gap;
      heartbeatCount++;
    }
  }
  lastHeartbeatAt = now;
}

void pushBleStatus(uint32_t now, int client = -1) {
  (void)now;
  int state = mouse.isConnected() ? 1 : 0;

  /* Only on change: no periodic traffic during a gesture. A newly connected
     client is sent the current state explicitly. */
  if (client < 0 && state == lastBleState) return;

  lastBleState = state;

  char msg[8];
  snprintf(msg, sizeof(msg), "B %d", state);

  if (client >= 0) webSocket.sendTXT((uint8_t)client, msg);
  else webSocket.broadcastTXT(msg);
}

void keepBleLinkActive(uint32_t now) {
  if (now - lastKeepAlive < KEEP_ALIVE_MS) return;
  lastKeepAlive = now;

  if (webSocket.connectedClients() == 0) return;
  if (!mouse.isConnected() || !mouse.isPaired()) return;

  /* Zero delta: refreshes the library idle clock without emitting a report. */
  mouse.addScroll(0);
}

void flushMovement(uint32_t now) {
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
    lastHeartbeatAt = 0;
    return;
  }

  if (type == WStype_CONNECTED) {
    pushBleStatus(millis(), (int)client);
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

    ledActivity(millis());
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
    ledActivity(lastButtonActivity);
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
      ledActivity(millis());
    }
  }

  else if (message[0] == 'K' &&
           isspace((unsigned char)message[1])) {

    /* Fixed-cadence heartbeat. Measures the phone-to-ESP32 path and keeps the
       phone's Wi-Fi radio out of power save between sparse movement packets. */
    noteHeartbeat(millis());
  }

  else if (message[0] == 'P' &&
           isspace((unsigned char)message[1])) {

    /* Latency probe. Reply: P <seq> <backlog> <gapMax> <gapMean> <loopMax> <n>
       - backlog: movement still queued here, in whole ±127 reports
       - gap*:    K heartbeat inter-arrival gap in ms, worst and mean
       - loopMax: longest main-loop stall in ms
       - n:       number of heartbeats measured */
    p++;
    if (!readNumber(p, a) || !commandFinished(p)) return;

    int32_t backlog = pendingMoveX < 0 ? -pendingMoveX : pendingMoveX;
    int32_t backlogY = pendingMoveY < 0 ? -pendingMoveY : pendingMoveY;
    if (backlogY > backlog) backlog = backlogY;

    uint32_t mean = heartbeatCount
      ? (heartbeatGapSum + heartbeatCount / 2) / heartbeatCount
      : 0;

    char reply[56];
    snprintf(reply, sizeof(reply), "P %ld %ld %lu %lu %lu %lu",
             a, (backlog + 126) / 127,
             (unsigned long)heartbeatGapMax,
             (unsigned long)mean,
             (unsigned long)loopMaxMs,
             (unsigned long)heartbeatCount);

    webSocket.sendTXT(client, reply);

    heartbeatGapSum = 0;
    heartbeatGapMax = 0;
    heartbeatCount = 0;
    loopMaxMs = 0;
  }
}

void disableHttpCache() {
  httpServer.sendHeader(
    "Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"
  );
  httpServer.sendHeader("Pragma", "no-cache");
  httpServer.sendHeader("Expires", "0");
  httpServer.sendHeader("X-Content-Type-Options", "nosniff");
  httpServer.sendHeader("Referrer-Policy", "no-referrer");
  httpServer.sendHeader(
    "Permissions-Policy", "accelerometer=(self), gyroscope=(self), magnetometer=()"
  );
  httpServer.sendHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'; object-src 'none'; "
    "script-src 'self'; style-src 'self'; "
    "connect-src 'self' ws://192.168.4.1:81"
  );
}

void setup() {
  Serial.begin(115200);

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, STATUS_LED_ACTIVE_HIGH ? LOW : HIGH);

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

  httpServer.on("/css/style.css", HTTP_GET, []() {
    disableHttpCache();
    httpServer.send_P(200, "text/css", STYLE_CSS);
  });

  httpServer.on("/app.js", HTTP_GET, []() {
    disableHttpCache();
    httpServer.send_P(200, "application/javascript", APP_JS);
  });

  httpServer.on("/js/app.js", HTTP_GET, []() {
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
  /* Serve the input socket before HTTP: a status request must never sit in
     front of a movement packet. The page no longer polls HTTP at all; the
     endpoint is kept for manual diagnostics. */
  webSocket.loop();
  httpServer.handleClient();

  uint32_t now = millis();

  if (lastLoopAt != 0) {
    uint32_t stall = now - lastLoopAt;
    if (stall > loopMaxMs) loopMaxMs = stall;
  }
  lastLoopAt = now;

  flushMovement(now);
  keepBleLinkActive(now);
  pushBleStatus(now);
  updateStatusLed(now);

  if (heldButtons != 0 &&
      millis() - lastButtonActivity >= BUTTON_TIMEOUT_MS) {
    releaseAllButtons();
  }

  delay(1);
}
