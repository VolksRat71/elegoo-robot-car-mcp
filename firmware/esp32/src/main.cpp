#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include "esp_camera.h"
#include "config.h"

// Forward declarations
void handleWebSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length);
void processCommand(uint8_t clientNum, JsonDocument &doc);
void sendToArduino(const String &cmd);
String readFromArduino(unsigned long timeout = 1000);
void sendResponse(uint8_t clientNum, bool success, const char *cmd, JsonVariant data = JsonVariant(), const char *error = nullptr);
void initCamera();
String captureImage();

// Global objects
WebSocketsServer webSocket(WS_PORT);
Servo cameraServo;
HardwareSerial ArduinoSerial(1);

// State
bool wifiConnected = false;
String currentMode = "manual";
unsigned long lastStatusUpdate = 0;

void setup() {
  // Debug serial
  Serial.begin(115200);
  Serial.println("\n\nElegoo Robot Car MCP Firmware");
  Serial.println("==============================");

  // Status LED
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Arduino serial connection
  ArduinoSerial.begin(ARDUINO_BAUD, SERIAL_8N1, ARDUINO_RX_PIN, ARDUINO_TX_PIN);
  Serial.printf("Arduino serial on TX:%d RX:%d @ %d baud\n", ARDUINO_TX_PIN, ARDUINO_RX_PIN, ARDUINO_BAUD);

  // Camera servo
  cameraServo.attach(SERVO_PIN);
  cameraServo.write(90); // Center position

  // Initialize camera
  initCamera();

  // WiFi setup
#if USE_STATION_MODE
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < WIFI_CONNECT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());
    digitalWrite(LED_PIN, HIGH);
  } else {
    Serial.println("\nStation mode failed, starting AP...");
#endif

    // Fallback to AP mode (or primary if station disabled)
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    Serial.printf("AP started: %s\n", AP_SSID);
    Serial.printf("IP: %s\n", WiFi.softAPIP().toString().c_str());
    wifiConnected = true;
    digitalWrite(LED_PIN, HIGH);

#if USE_STATION_MODE
  }
#endif

  // Start WebSocket server
  webSocket.begin();
  webSocket.onEvent(handleWebSocketEvent);
  Serial.printf("WebSocket server on port %d\n", WS_PORT);

  Serial.println("Ready!");
}

void loop() {
  webSocket.loop();

  // Periodic status broadcast
  if (millis() - lastStatusUpdate > 5000) {
    lastStatusUpdate = millis();
    // Could broadcast status to all clients here
  }

  // Handle any autonomous behavior based on mode
  if (currentMode == "obstacle_avoid") {
    // Autonomous obstacle avoidance logic would go here
  } else if (currentMode == "line_follow") {
    // Line following logic would go here
  }
}

void handleWebSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.printf("Client %u disconnected\n", num);
      // Stop motors on disconnect for safety
      sendToArduino("{\"N\":100}"); // Stop command
      break;

    case WStype_CONNECTED:
      {
        IPAddress ip = webSocket.remoteIP(num);
        Serial.printf("Client %u connected from %s\n", num, ip.toString().c_str());
      }
      break;

    case WStype_TEXT:
      {
        Serial.printf("Received from %u: %s\n", num, payload);

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, payload, length);

        if (error) {
          sendResponse(num, false, "parse", JsonVariant(), error.c_str());
          return;
        }

        processCommand(num, doc);
      }
      break;

    default:
      break;
  }
}

void processCommand(uint8_t clientNum, JsonDocument &doc) {
  const char *cmd = doc["cmd"];
  const char *requestId = doc["requestId"];

  if (!cmd) {
    sendResponse(clientNum, false, "unknown", JsonVariant(), "Missing 'cmd' field");
    return;
  }

  String cmdStr = String(cmd);

  // Movement commands
  if (cmdStr == "drive") {
    const char *dir = doc["dir"];
    int speed = doc["speed"] | 50;
    int duration = doc["duration"] | 0;

    // Convert to Elegoo protocol
    // N:1=forward, N:2=backward, N:3=left, N:4=right, N:100=stop
    int cmdCode = 100; // stop
    if (strcmp(dir, "forward") == 0) cmdCode = 1;
    else if (strcmp(dir, "backward") == 0) cmdCode = 2;
    else if (strcmp(dir, "left") == 0) cmdCode = 3;
    else if (strcmp(dir, "right") == 0) cmdCode = 4;
    else if (strcmp(dir, "stop") == 0) cmdCode = 100;

    // Send to Arduino
    String arduinoCmd = "{\"N\":" + String(cmdCode) + ",\"S\":" + String(speed) + "}";
    sendToArduino(arduinoCmd);

    // If duration specified, schedule stop
    if (duration > 0 && cmdCode != 100) {
      delay(duration);
      sendToArduino("{\"N\":100}");
    }

    JsonDocument response;
    response["direction"] = dir;
    response["speed"] = speed;
    response["duration"] = duration;
    sendResponse(clientNum, true, cmd, response.as<JsonVariant>());
  }
  else if (cmdStr == "turn") {
    int degrees = doc["degrees"] | 0;
    int speed = doc["speed"] | 50;

    // Estimate turn duration based on degrees and speed
    // At speed 100, robot turns ~90 degrees per second (approximate)
    int duration = abs(degrees) * 1000 / (90 * speed / 100);

    int cmdCode = degrees > 0 ? 4 : 3; // right : left
    String arduinoCmd = "{\"N\":" + String(cmdCode) + ",\"S\":" + String(speed) + "}";
    sendToArduino(arduinoCmd);

    delay(duration);
    sendToArduino("{\"N\":100}");

    JsonDocument response;
    response["degrees"] = degrees;
    response["speed"] = speed;
    sendResponse(clientNum, true, cmd, response.as<JsonVariant>());
  }
  else if (cmdStr == "emergency_stop") {
    sendToArduino("{\"N\":100}");
    sendResponse(clientNum, true, cmd);
  }
  // Servo command
  else if (cmdStr == "servo") {
    int angle = doc["angle"] | 90;
    angle = constrain(angle, 0, 180);
    cameraServo.write(angle);

    JsonDocument response;
    response["angle"] = angle;
    sendResponse(clientNum, true, cmd, response.as<JsonVariant>());
  }
  // Camera command
  else if (cmdStr == "camera") {
    const char *action = doc["action"];

    if (strcmp(action, "capture") == 0) {
      String imageBase64 = captureImage();

      if (imageBase64.length() > 0) {
        JsonDocument response;
        response["format"] = "jpeg";
        response["encoding"] = "base64";
        response["data"] = imageBase64;
        sendResponse(clientNum, true, cmd, response.as<JsonVariant>());
      } else {
        sendResponse(clientNum, false, cmd, JsonVariant(), "Failed to capture image");
      }
    } else {
      sendResponse(clientNum, false, cmd, JsonVariant(), "Unknown camera action");
    }
  }
  // Sensor commands
  else if (cmdStr == "sensor") {
    const char *type = doc["type"];

    if (strcmp(type, "distance") == 0) {
      // Request distance from Arduino
      sendToArduino("{\"N\":21}"); // Ultrasonic read command
      String response = readFromArduino(500);

      // Parse response - Arduino returns something like {"N":21,"D":25.5}
      JsonDocument respDoc;
      DeserializationError err = deserializeJson(respDoc, response);

      JsonDocument data;
      if (!err && respDoc.containsKey("D")) {
        data["distance"] = respDoc["D"].as<float>();
      } else {
        data["distance"] = -1;
        data["error"] = "Failed to read sensor";
      }
      sendResponse(clientNum, !err, cmd, data.as<JsonVariant>());
    }
    else if (strcmp(type, "line") == 0) {
      // Request line sensors from Arduino
      sendToArduino("{\"N\":22}"); // Line sensor read command
      String response = readFromArduino(500);

      JsonDocument respDoc;
      DeserializationError err = deserializeJson(respDoc, response);

      JsonDocument data;
      if (!err) {
        data["left"] = respDoc["L"].as<bool>();
        data["center"] = respDoc["C"].as<bool>();
        data["right"] = respDoc["R"].as<bool>();
      } else {
        data["left"] = false;
        data["center"] = false;
        data["right"] = false;
        data["error"] = "Failed to read sensors";
      }
      sendResponse(clientNum, !err, cmd, data.as<JsonVariant>());
    }
    else {
      sendResponse(clientNum, false, cmd, JsonVariant(), "Unknown sensor type");
    }
  }
  // Scan command (pan servo and take distance readings)
  else if (cmdStr == "scan") {
    int startAngle = doc["startAngle"] | 0;
    int endAngle = doc["endAngle"] | 180;
    int step = doc["step"] | 10;

    JsonDocument data;
    JsonArray readings = data["readings"].to<JsonArray>();

    for (int angle = startAngle; angle <= endAngle; angle += step) {
      cameraServo.write(angle);
      delay(200); // Wait for servo to move

      sendToArduino("{\"N\":21}");
      String response = readFromArduino(500);

      JsonDocument respDoc;
      DeserializationError err = deserializeJson(respDoc, response);

      JsonObject reading = readings.add<JsonObject>();
      reading["angle"] = angle;
      if (!err && respDoc.containsKey("D")) {
        reading["distance"] = respDoc["D"].as<float>();
      } else {
        reading["distance"] = -1;
      }
    }

    // Return to center
    cameraServo.write(90);

    sendResponse(clientNum, true, cmd, data.as<JsonVariant>());
  }
  // Status command
  else if (cmdStr == "status") {
    JsonDocument data;
    data["mode"] = currentMode;
    data["wifiSignal"] = WiFi.RSSI();
    data["uptime"] = millis() / 1000;

    // Battery would need ADC reading - placeholder
    data["battery"] = 100;

    sendResponse(clientNum, true, cmd, data.as<JsonVariant>());
  }
  // Set mode command
  else if (cmdStr == "set_mode") {
    const char *mode = doc["mode"];
    if (mode) {
      currentMode = String(mode);

      // Stop any current movement when changing modes
      sendToArduino("{\"N\":100}");

      JsonDocument data;
      data["mode"] = currentMode;
      sendResponse(clientNum, true, cmd, data.as<JsonVariant>());
    } else {
      sendResponse(clientNum, false, cmd, JsonVariant(), "Missing mode parameter");
    }
  }
  else {
    sendResponse(clientNum, false, cmd, JsonVariant(), "Unknown command");
  }
}

void sendResponse(uint8_t clientNum, bool success, const char *cmd, JsonVariant data, const char *error) {
  JsonDocument doc;
  doc["success"] = success;
  doc["cmd"] = cmd;

  if (!data.isNull()) {
    doc["data"] = data;
  }

  if (error) {
    doc["error"] = error;
  }

  String response;
  serializeJson(doc, response);
  webSocket.sendTXT(clientNum, response);
}

void sendToArduino(const String &cmd) {
  ArduinoSerial.println(cmd);
  Serial.printf("-> Arduino: %s\n", cmd.c_str());
}

String readFromArduino(unsigned long timeout) {
  unsigned long start = millis();
  String response = "";

  while (millis() - start < timeout) {
    if (ArduinoSerial.available()) {
      char c = ArduinoSerial.read();
      if (c == '\n') break;
      response += c;
    }
  }

  Serial.printf("<- Arduino: %s\n", response.c_str());
  return response;
}

void initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA; // 640x480
  config.jpeg_quality = 12;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
  } else {
    Serial.println("Camera initialized");
  }
}

String captureImage() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return "";
  }

  // Base64 encode
  String encoded = base64Encode(fb->buf, fb->len);

  esp_camera_fb_return(fb);
  return encoded;
}

// Simple base64 encoder
String base64Encode(const uint8_t *data, size_t length) {
  static const char *base64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  String encoded;
  encoded.reserve(((length + 2) / 3) * 4);

  for (size_t i = 0; i < length; i += 3) {
    uint32_t n = ((uint32_t)data[i]) << 16;
    if (i + 1 < length) n |= ((uint32_t)data[i + 1]) << 8;
    if (i + 2 < length) n |= data[i + 2];

    encoded += base64_chars[(n >> 18) & 0x3F];
    encoded += base64_chars[(n >> 12) & 0x3F];
    encoded += (i + 1 < length) ? base64_chars[(n >> 6) & 0x3F] : '=';
    encoded += (i + 2 < length) ? base64_chars[n & 0x3F] : '=';
  }

  return encoded;
}
