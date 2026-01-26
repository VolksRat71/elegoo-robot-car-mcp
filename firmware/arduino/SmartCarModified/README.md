# SmartCarModified - Elegoo Robot Car V4.0 (Slimmed Firmware)

Optimized firmware for MCP-controlled operation. Reduced from 31KB (96%) to 21KB (65%) by removing unused features.

## What's Included

- Motor control (forward, backward, left, right, stop)
- Ultrasonic distance sensor (5-sample median filtering)
- Servo control (pan for sensor head)
- Line tracking mode
- Obstacle avoidance mode
- RGB LED status indicator
- Serial command parsing (JSON protocol)
- Battery voltage monitoring

## What's Removed

- IR remote control (library + handler)
- MPU6050 gyroscope (yaw drift correction)
- Follow mode
- Rocker/joystick mode
- Physical button mode switching
- Complex LED lighting patterns

## LED Status

| Color | Meaning |
|-------|---------|
| Green | Standby (ready) |
| Yellow | Line tracking mode |
| Orange | Obstacle avoidance mode |
| Blue | Active/other modes |
| Red blink | Low battery warning |

## Pin Reference

| Pin | Name | Function |
|-----|------|----------|
| D2 | `PIN_MODE_BUTTON` | Mode selection button |
| D3 | `PIN_MOTOR_STANDBY` | TB6612 enable (must be HIGH) |
| D4 | `PIN_RGB_LED` | NeoPixel data |
| D5 | `PIN_MOTOR_RIGHT_PWM` | Right motor speed |
| D6 | `PIN_MOTOR_LEFT_PWM` | Left motor speed |
| D7 | `PIN_MOTOR_RIGHT_DIR` | Right motor direction |
| D8 | `PIN_MOTOR_LEFT_DIR` | Left motor direction |
| D10 | `PIN_SERVO_PAN` | Pan servo (horizontal) |
| D12 | `PIN_ULTRASONIC_ECHO` | HC-SR04 echo |
| D13 | `PIN_ULTRASONIC_TRIG` | HC-SR04 trigger |
| A0 | `PIN_LINE_SENSOR_RIGHT` | Line tracking right |
| A1 | `PIN_LINE_SENSOR_CENTER` | Line tracking center |
| A2 | `PIN_LINE_SENSOR_LEFT` | Line tracking left |
| A3 | `PIN_BATTERY_VOLTAGE` | Battery voltage divider |
| A4 | `PIN_I2C_SDA` | **Available** (was MPU6050) |
| A5 | `PIN_I2C_SCL` | **Available** (was MPU6050) |

## Uploading

Using Makefile (recommended):
```bash
cd firmware/arduino
make flash-modified
```

Or manually:
1. Open `SmartCarModified.ino` in Arduino IDE
2. Select Board: "Arduino Uno"
3. Select your COM port
4. Upload

## Size

```
Sketch:  21,150 bytes (65% of 32,256 bytes)
RAM:     606 bytes (29% of 2,048 bytes)
```

## Future: VL53L1X ToF Sensor

The HC-SR04 ultrasonic sensor is unreliable. A VL53L1X Time-of-Flight sensor upgrade is planned:
- Uses I2C (A4/A5 pins now available)
- Much more accurate distance readings
- Will require driver changes in `DeviceDriverSet_xxx0.cpp`

## Original Stock Firmware

Unmodified stock firmware preserved at:
```
firmware/arduino/SmartRobotCarV4.0_TB6612_MPU6050/
```
