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

// ============================================================================
// IR REMOTE CODES (Remote A)
// ============================================================================

#define IR_CODE_UP              16736925
#define IR_CODE_DOWN            16754775
#define IR_CODE_LEFT            16720605
#define IR_CODE_RIGHT           16761405
#define IR_CODE_OK              16712445
#define IR_CODE_1               16738455
#define IR_CODE_2               16750695
#define IR_CODE_3               16756815
#define IR_CODE_4               16724175
#define IR_CODE_5               16718055
#define IR_CODE_6               16743045
#define IR_CODE_7               16716015
#define IR_CODE_8               16726215
#define IR_CODE_9               16734885

// Legacy aliases
#define aRECV_upper         IR_CODE_UP
#define aRECV_lower         IR_CODE_DOWN
#define aRECV_Left          IR_CODE_LEFT
#define aRECV_right         IR_CODE_RIGHT
#define aRECV_ok            IR_CODE_OK
#define aRECV_1             IR_CODE_1
#define aRECV_2             IR_CODE_2
#define aRECV_3             IR_CODE_3
#define aRECV_4             IR_CODE_4
#define aRECV_5             IR_CODE_5
#define aRECV_6             IR_CODE_6
#define aRECV_7             IR_CODE_7
#define aRECV_8             IR_CODE_8
#define aRECV_9             IR_CODE_9

// ============================================================================
// IR REMOTE CODES (Remote B - alternate remote)
// ============================================================================

#define IR_CODE_B_UP            5316027
#define IR_CODE_B_DOWN          2747854299
#define IR_CODE_B_LEFT          1386468383
#define IR_CODE_B_RIGHT         553536955
#define IR_CODE_B_OK            3622325019
#define IR_CODE_B_1             3238126971
#define IR_CODE_B_2             2538093563
#define IR_CODE_B_3             4039382595
#define IR_CODE_B_4             2534850111
#define IR_CODE_B_5             1033561079
#define IR_CODE_B_6             1635910171
#define IR_CODE_B_7             2351064443
#define IR_CODE_B_8             1217346747
#define IR_CODE_B_9             71952287

// Legacy aliases
#define bRECV_upper         IR_CODE_B_UP
#define bRECV_lower         IR_CODE_B_DOWN
#define bRECV_Left          IR_CODE_B_LEFT
#define bRECV_right         IR_CODE_B_RIGHT
#define bRECV_ok            IR_CODE_B_OK
#define bRECV_1             IR_CODE_B_1
#define bRECV_2             IR_CODE_B_2
#define bRECV_3             IR_CODE_B_3
#define bRECV_4             IR_CODE_B_4
#define bRECV_5             IR_CODE_B_5
#define bRECV_6             IR_CODE_B_6
#define bRECV_7             IR_CODE_B_7
#define bRECV_8             IR_CODE_B_8
#define bRECV_9             IR_CODE_B_9

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
