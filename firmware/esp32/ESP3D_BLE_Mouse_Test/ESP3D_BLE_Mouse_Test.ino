#include <HijelHID_BLEMouse.h>

HijelBLEMouse mouse("ESP3D", "ESP3D Project", 100, 5, true);

void setup() {
    Serial.begin(115200);

    mouse.setLogLevel(HIDLogLevel::Normal);
    mouse.setUpdateRate(HIDRate::Hz125);

    mouse.begin();

    Serial.println("ESP3D BLE Mouse initialized.");
}

void loop() {
    delay(100);
}
