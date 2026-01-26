/**
 * @file pins.h
 * @brief Centralized pin definitions for Elegoo Smart Robot Car V4.0
 *
 * Hardware: Arduino Nano + TB6612 Motor Driver + HC-SR04 Ultrasonic
 *
 * Pin Map:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Arduino Nano Pin Assignments                                │
 * ├─────────┬──────────────────────────────────────────────────┤
 * │ D2      │ Mode Button (interrupt capable)                  │
 * │ D3      │ Motor Driver Standby (PWM capable)               │
 * │ D4      │ RGB LED (NeoPixel/WS2812)                        │
 * │ D5      │ Right Motor PWM (Timer0)                         │
 * │ D6      │ Left Motor PWM (Timer0)                          │
 * │ D7      │ Right Motor Direction                            │
 * │ D8      │ Left Motor Direction                             │
 * │ D9      │ IR Receiver (PWM capable)                        │
 * │ D10     │ Pan Servo - Horizontal (PWM capable)             │
 * │ D11     │ Tilt Servo - Vertical (PWM capable)              │
 * │ D12     │ Ultrasonic Echo                                  │
 * │ D13     │ Ultrasonic Trigger (onboard LED)                 │
 * │ A0      │ Line Sensor Right                                │
 * │ A1      │ Line Sensor Center                               │
 * │ A2      │ Line Sensor Left                                 │
 * │ A3      │ Battery Voltage Divider                          │
 * │ A4      │ I2C SDA (MPU6050)                                │
 * │ A5      │ I2C SCL (MPU6050)                                │
 * └─────────┴──────────────────────────────────────────────────┘
 */

#ifndef _PINS_H_
#define _PINS_H_

// ============================================================================
// MOTOR DRIVER (TB6612FNG)
// ============================================================================
// The TB6612 is a dual H-bridge motor driver
// STBY must be HIGH for motors to operate

#define PIN_MOTOR_RIGHT_PWM     5   // PWMA - Right motor speed (0-255)
#define PIN_MOTOR_LEFT_PWM      6   // PWMB - Left motor speed (0-255)
#define PIN_MOTOR_RIGHT_DIR     7   // AIN1 - Right motor direction (HIGH=forward)
#define PIN_MOTOR_LEFT_DIR      8   // BIN1 - Left motor direction (HIGH=forward)
#define PIN_MOTOR_STANDBY       3   // STBY - Must be HIGH to enable motors

// Legacy aliases (for compatibility with original code)
#define PIN_Motor_PWMA      PIN_MOTOR_RIGHT_PWM
#define PIN_Motor_PWMB      PIN_MOTOR_LEFT_PWM
#define PIN_Motor_AIN_1     PIN_MOTOR_RIGHT_DIR
#define PIN_Motor_BIN_1     PIN_MOTOR_LEFT_DIR
#define PIN_Motor_STBY      PIN_MOTOR_STANDBY

// ============================================================================
// ULTRASONIC SENSOR (HC-SR04)
// ============================================================================
// Trigger: Send 10us HIGH pulse to initiate measurement
// Echo: Returns pulse width proportional to distance (58us per cm)

#define PIN_ULTRASONIC_TRIG     13  // Trigger output
#define PIN_ULTRASONIC_ECHO     12  // Echo input

// Legacy aliases
#define TRIG_PIN            PIN_ULTRASONIC_TRIG
#define ECHO_PIN            PIN_ULTRASONIC_ECHO

// ============================================================================
// SERVO MOTORS (Pan/Tilt for Ultrasonic)
// ============================================================================
// Standard hobby servos, 0-180 degree range
// Pan (Z-axis): Left/Right rotation
// Tilt (Y-axis): Up/Down rotation

#define PIN_SERVO_PAN           10  // Horizontal rotation (Z-axis)
#define PIN_SERVO_TILT          11  // Vertical rotation (Y-axis)

// Legacy aliases
#define PIN_Servo_z         PIN_SERVO_PAN
#define PIN_Servo_y         PIN_SERVO_TILT

// ============================================================================
// LINE TRACKING SENSORS (ITR20001 - 3x IR Reflective)
// ============================================================================
// Analog sensors - LOW value = reflective surface (white line)
//                  HIGH value = non-reflective (black surface)

#define PIN_LINE_SENSOR_LEFT    A2  // Left IR sensor
#define PIN_LINE_SENSOR_CENTER  A1  // Center IR sensor
#define PIN_LINE_SENSOR_RIGHT   A0  // Right IR sensor

// Legacy aliases
#define PIN_ITR20001xxxL    PIN_LINE_SENSOR_LEFT
#define PIN_ITR20001xxxM    PIN_LINE_SENSOR_CENTER
#define PIN_ITR20001xxxR    PIN_LINE_SENSOR_RIGHT

// ============================================================================
// RGB LED (WS2812/NeoPixel)
// ============================================================================

#define PIN_RGB_LED             4   // Data pin for addressable LED
#define NUM_RGB_LEDS            1   // Number of LEDs in chain

// Legacy aliases
#define PIN_RBGLED          PIN_RGB_LED
#define NUM_LEDS            NUM_RGB_LEDS

// ============================================================================
// MODE BUTTON
// ============================================================================
// Cycles through operating modes when pressed
// Connected to INT0 for interrupt-driven detection

#define PIN_MODE_BUTTON         2   // Mode selection button (INT0)

// Legacy alias
#define PIN_Key             PIN_MODE_BUTTON

// ============================================================================
// IR RECEIVER
// ============================================================================
// For remote control input (38kHz carrier)

#define PIN_IR_RECEIVER         9   // IR receiver data pin

// Legacy alias
#define RECV_PIN            PIN_IR_RECEIVER

// ============================================================================
// BATTERY VOLTAGE MONITOR
// ============================================================================
// Voltage divider circuit for battery level monitoring
// Actual voltage = analogRead * (5.0 / 1023.0) * divider_ratio

#define PIN_BATTERY_VOLTAGE     A3  // Voltage divider input

// Legacy alias
#define PIN_Voltage         PIN_BATTERY_VOLTAGE

// ============================================================================
// I2C BUS (MPU6050 IMU)
// ============================================================================
// Hardware I2C pins - used by Wire library automatically
// Defined here for documentation purposes

#define PIN_I2C_SDA             A4  // I2C Data
#define PIN_I2C_SCL             A5  // I2C Clock

#endif // _PINS_H_
