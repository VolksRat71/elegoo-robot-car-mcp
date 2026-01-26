/**
 * @file config.h
 * @brief Configuration constants and thresholds for Elegoo Smart Robot Car V4.0
 *
 * This file contains all tunable parameters for robot behavior.
 * Adjust these values to calibrate sensors and modify behavior.
 */

#ifndef _CONFIG_H_
#define _CONFIG_H_

// ============================================================================
// MOTOR CONFIGURATION
// ============================================================================

#define MOTOR_SPEED_MAX         255     // Maximum PWM value (0-255)
#define MOTOR_SPEED_MIN         0       // Minimum PWM value
#define MOTOR_SPEED_DEFAULT     200     // Default driving speed

// Direction constants
#define MOTOR_DIR_FORWARD       true    // HIGH = forward rotation
#define MOTOR_DIR_REVERSE       false   // LOW = reverse rotation

// Legacy aliases
#define speed_Max           MOTOR_SPEED_MAX
#define direction_just      MOTOR_DIR_FORWARD
#define direction_back      MOTOR_DIR_REVERSE
#define direction_void      3

// ============================================================================
// ULTRASONIC SENSOR CONFIGURATION
// ============================================================================

#define ULTRASONIC_MAX_DISTANCE_CM      200     // Max measurable distance
#define ULTRASONIC_FIRMWARE_CAP_CM      150     // Firmware caps readings at this
#define ULTRASONIC_TIMEOUT_US           30000   // Timeout for echo (30ms ~ 5m)

// Obstacle detection threshold
#define OBSTACLE_DISTANCE_CM            20      // Distance to trigger obstacle alert

// Legacy alias
#define MAX_DISTANCE        ULTRASONIC_MAX_DISTANCE_CM

// ============================================================================
// LINE TRACKING CONFIGURATION
// ============================================================================
// Sensor values: ~0-1023 (10-bit ADC)
// Lower values = more reflective (white line on dark surface)
// Higher values = less reflective (dark surface)

#define LINE_THRESHOLD_WHITE    250     // Below this = white/reflective
#define LINE_THRESHOLD_BLACK    850     // Above this = black/non-reflective
#define LINE_THRESHOLD_GROUND   950     // Above this = no ground (lifted)

// Legacy aliases (these are variables in original code, kept for reference)
// TrackingDetection_S = LINE_THRESHOLD_WHITE
// TrackingDetection_E = LINE_THRESHOLD_BLACK
// TrackingDetection_V = LINE_THRESHOLD_GROUND

// ============================================================================
// BATTERY MONITORING
// ============================================================================

#define BATTERY_LOW_VOLTAGE     7.00f   // Low battery warning threshold (volts)
#define BATTERY_CRITICAL        6.50f   // Critical - should stop operation

// Voltage divider ratio (measure and calibrate for your hardware)
// Actual_Voltage = ADC_Reading * (5.0 / 1023.0) * VOLTAGE_DIVIDER_RATIO
#define VOLTAGE_DIVIDER_RATIO   3.0f    // Adjust based on your resistor values

// ============================================================================
// SERVO CONFIGURATION
// ============================================================================

#define SERVO_PAN_MIN           0       // Pan left limit (degrees)
#define SERVO_PAN_MAX           180     // Pan right limit (degrees)
#define SERVO_PAN_CENTER        90      // Pan center position

#define SERVO_TILT_MIN          0       // Tilt down limit (degrees)
#define SERVO_TILT_MAX          180     // Tilt up limit (degrees)
#define SERVO_TILT_CENTER       90      // Tilt center position

#define SERVO_DEFAULT_ANGLE     90      // Default position on init

// ============================================================================
// RGB LED CONFIGURATION
// ============================================================================

#define LED_BRIGHTNESS_DEFAULT  20      // Default brightness (0-255)
#define LED_BRIGHTNESS_MAX      255     // Maximum brightness

// ============================================================================
// TIMING CONFIGURATION
// ============================================================================

#define SERIAL_BAUD_RATE        9600    // Serial communication speed
#define WATCHDOG_TIMEOUT        WDTO_2S // Watchdog timer (2 seconds)

// Sensor update intervals (milliseconds)
#define SENSOR_UPDATE_INTERVAL  50      // How often to read sensors
#define HEARTBEAT_INTERVAL      10000   // Connection keepalive (10s)

// ============================================================================
// MODE BUTTON CONFIGURATION
// ============================================================================

#define BUTTON_DEBOUNCE_MS      50      // Debounce time for button
#define MODE_COUNT_MAX          4       // Number of operating modes

// Legacy alias
#define keyValue_Max        MODE_COUNT_MAX

// ============================================================================
// CONTROL FLAGS
// ============================================================================

#define CONTROL_ENABLED         true
#define CONTROL_DISABLED        false
#define DURATION_ENABLED        true
#define DURATION_DISABLED       false

// Legacy aliases
#define control_enable      CONTROL_ENABLED
#define control_disable     CONTROL_DISABLED
#define Duration_enable     DURATION_ENABLED
#define Duration_disable    DURATION_DISABLED

// ============================================================================
// DEBUG FLAGS
// ============================================================================

#define DEBUG_ENABLED           0       // Set to 1 to enable debug output
#define TEST_DEVICE_DRIVERS     0       // Set to 1 to enable driver tests

// Legacy alias
#define _Test_DeviceDriverSet   TEST_DEVICE_DRIVERS

#endif // _CONFIG_H_
