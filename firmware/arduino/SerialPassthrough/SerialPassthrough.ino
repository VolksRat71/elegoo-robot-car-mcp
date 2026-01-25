/*
 * Serial Passthrough for ESP32 Flashing
 *
 * This sketch turns the Arduino into a USB-to-Serial bridge,
 * forwarding data between USB (Serial) and ESP32 (SoftwareSerial).
 *
 * For Elegoo Smart Robot Car V4.0:
 * - Arduino RX from ESP32: Pin 4
 * - Arduino TX to ESP32: Pin 5
 *
 * If these pins don't work, try swapping or using 2/3.
 */

#include <SoftwareSerial.h>

// Pins connected to ESP32 (adjust if needed)
#define ESP32_RX_PIN 4  // Arduino receives from ESP32 TX
#define ESP32_TX_PIN 5  // Arduino transmits to ESP32 RX

// Baud rate - ESP32 bootloader uses 115200
#define BAUD_RATE 115200

SoftwareSerial espSerial(ESP32_RX_PIN, ESP32_TX_PIN);

void setup() {
  // USB Serial to Mac
  Serial.begin(BAUD_RATE);

  // Software Serial to ESP32
  espSerial.begin(BAUD_RATE);

  // Brief indicator that we're ready
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  delay(200);
  digitalWrite(LED_BUILTIN, LOW);
}

void loop() {
  // Forward USB -> ESP32
  while (Serial.available()) {
    espSerial.write(Serial.read());
  }

  // Forward ESP32 -> USB
  while (espSerial.available()) {
    Serial.write(espSerial.read());
  }
}
