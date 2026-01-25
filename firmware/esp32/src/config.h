#ifndef CONFIG_H
#define CONFIG_H

// WiFi Configuration
// Set USE_STATION_MODE to true to join existing WiFi network
// Set to false to create an access point
#define USE_STATION_MODE true

// Station mode credentials (defined via build flags in secrets.ini)
#ifndef WIFI_SSID
#define WIFI_SSID "YOUR_WIFI_SSID"
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#endif

// AP mode settings (fallback or primary)
#define AP_SSID "ELEGOO-ROBOT"
#define AP_PASSWORD "elegoo1234"

// WebSocket server port
#define WS_PORT 8080

// UART to Arduino settings
#define ARDUINO_TX_PIN 4
#define ARDUINO_RX_PIN 33
#define ARDUINO_BAUD 9600

// Camera pins (ESP32-S3 WROOM on Elegoo V4)
#define PWDN_GPIO_NUM    -1
#define RESET_GPIO_NUM   -1
#define XCLK_GPIO_NUM    15
#define SIOD_GPIO_NUM    4
#define SIOC_GPIO_NUM    5

#define Y9_GPIO_NUM      16
#define Y8_GPIO_NUM      17
#define Y7_GPIO_NUM      18
#define Y6_GPIO_NUM      12
#define Y5_GPIO_NUM      10
#define Y4_GPIO_NUM       8
#define Y3_GPIO_NUM       9
#define Y2_GPIO_NUM      11
#define VSYNC_GPIO_NUM    6
#define HREF_GPIO_NUM     7
#define PCLK_GPIO_NUM    13

// Servo pin for camera pan
#define SERVO_PIN 14

// Status LED
#define LED_PIN 2

// Timeouts
#define WIFI_CONNECT_TIMEOUT_MS 10000
#define COMMAND_TIMEOUT_MS 5000

#endif // CONFIG_H
