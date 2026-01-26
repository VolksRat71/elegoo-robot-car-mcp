/**
 * @file DeviceDriverSet_xxx0.h
 * @brief Device driver class declarations for Elegoo Smart Robot Car V4.0
 *
 * Original: ELEGOO (2019-2020)
 * Modified: Consolidated pin definitions into pins.h, constants into config.h
 */

#ifndef _DeviceDriverSet_xxx0_H_
#define _DeviceDriverSet_xxx0_H_

#include <Arduino.h>
#include "pins.h"
#include "config.h"

// ============================================================================
// RGB LED Driver (WS2812/NeoPixel via FastLED)
// ============================================================================
#include "FastLED.h"

class DeviceDriverSet_RBGLED
{
public:
    void DeviceDriverSet_RBGLED_Init(uint8_t set_Brightness);
    void DeviceDriverSet_RBGLED_xxx(uint16_t Duration, uint8_t Traversal_Number, CRGB colour);
    void DeviceDriverSet_RBGLED_Color(uint8_t LED_s, uint8_t r, uint8_t g, uint8_t b);

#if TEST_DEVICE_DRIVERS
    void DeviceDriverSet_RBGLED_Test(void);
#endif

public:
    CRGB leds[NUM_RGB_LEDS];
};

// ============================================================================
// Mode Button Driver
// ============================================================================
class DeviceDriverSet_Key
{
public:
    void DeviceDriverSet_Key_Init(void);
    void DeviceDriverSet_key_Get(uint8_t *get_keyValue);

#if TEST_DEVICE_DRIVERS
    void DeviceDriverSet_Key_Test(void);
#endif

public:
    static const uint8_t keyValue_Max = MODE_COUNT_MAX;
    static uint8_t keyValue;
};

// ============================================================================
// Line Tracking Sensors (ITR20001 - 3x IR Reflective)
// ============================================================================
class DeviceDriverSet_ITR20001
{
public:
    bool DeviceDriverSet_ITR20001_Init(void);
    int DeviceDriverSet_ITR20001_getAnaloguexxx_L(void);
    int DeviceDriverSet_ITR20001_getAnaloguexxx_M(void);
    int DeviceDriverSet_ITR20001_getAnaloguexxx_R(void);

#if TEST_DEVICE_DRIVERS
    void DeviceDriverSet_ITR20001_Test(void);
#endif
};

// ============================================================================
// Battery Voltage Monitor
// ============================================================================
class DeviceDriverSet_Voltage
{
public:
    void DeviceDriverSet_Voltage_Init(void);
    float DeviceDriverSet_Voltage_getAnalogue(void);

#if TEST_DEVICE_DRIVERS
    void DeviceDriverSet_Voltage_Test(void);
#endif
};

// ============================================================================
// Motor Driver (TB6612FNG Dual H-Bridge)
// ============================================================================
class DeviceDriverSet_Motor
{
public:
    void DeviceDriverSet_Motor_Init(void);
    void DeviceDriverSet_Motor_control(
        boolean direction_A, uint8_t speed_A,   // Right motor (A) parameters
        boolean direction_B, uint8_t speed_B,   // Left motor (B) parameters
        boolean controlED                       // Enable control (true to activate)
    );

#if TEST_DEVICE_DRIVERS
    void DeviceDriverSet_Motor_Test(void);
#endif
};

// ============================================================================
// Ultrasonic Distance Sensor (HC-SR04)
// ============================================================================
class DeviceDriverSet_ULTRASONIC
{
public:
    void DeviceDriverSet_ULTRASONIC_Init(void);
    void DeviceDriverSet_ULTRASONIC_Get(uint16_t *ULTRASONIC_Get /*out*/);

#if TEST_DEVICE_DRIVERS
    void DeviceDriverSet_ULTRASONIC_Test(void);
#endif
};

// ============================================================================
// Servo Motors (Pan/Tilt for sensor head)
// ============================================================================
#include <Servo.h>

class DeviceDriverSet_Servo
{
public:
    void DeviceDriverSet_Servo_Init(unsigned int Position_angle);
    void DeviceDriverSet_Servo_control(unsigned int Position_angle);
    void DeviceDriverSet_Servo_controls(uint8_t Servo, unsigned int Position_angle);

#if TEST_DEVICE_DRIVERS
    void DeviceDriverSet_Servo_Test(void);
#endif
};

// ============================================================================
// IR Receiver (38kHz Remote Control)
// ============================================================================
#include "IRremote.h"

class DeviceDriverSet_IRrecv
{
public:
    void DeviceDriverSet_IRrecv_Init(void);
    bool DeviceDriverSet_IRrecv_Get(uint8_t *IRrecv_Get /*out*/);
    void DeviceDriverSet_IRrecv_Test(void);

public:
    unsigned long IR_PreMillis;
};

#endif // _DeviceDriverSet_xxx0_H_
