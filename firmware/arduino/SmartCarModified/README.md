# SmartCarModified - Elegoo Robot Car V4.0 (Modified Firmware)

This is a cleaned-up copy of the stock Elegoo Smart Robot Car V4.0 firmware, reorganized for easier modification and understanding.

## Changes from Stock

### New Files
- **`pins.h`** - All pin definitions in one place with clear documentation
- **`config.h`** - All configurable constants (thresholds, speeds, IR codes)

### Modifications
- `DeviceDriverSet_xxx0.h` - Now includes `pins.h` and `config.h`, removed inline #defines
- All legacy constant names are aliased for compatibility with `.cpp` files

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
| D9 | `PIN_IR_RECEIVER` | IR remote receiver |
| D10 | `PIN_SERVO_PAN` | Pan servo (horizontal) |
| D11 | `PIN_SERVO_TILT` | Tilt servo (vertical) |
| D12 | `PIN_ULTRASONIC_ECHO` | HC-SR04 echo |
| D13 | `PIN_ULTRASONIC_TRIG` | HC-SR04 trigger |
| A0 | `PIN_LINE_SENSOR_RIGHT` | Line tracking right |
| A1 | `PIN_LINE_SENSOR_CENTER` | Line tracking center |
| A2 | `PIN_LINE_SENSOR_LEFT` | Line tracking left |
| A3 | `PIN_BATTERY_VOLTAGE` | Battery voltage divider |
| A4 | `PIN_I2C_SDA` | MPU6050 data |
| A5 | `PIN_I2C_SCL` | MPU6050 clock |

## Key Configuration Values (config.h)

| Constant | Default | Description |
|----------|---------|-------------|
| `MOTOR_SPEED_MAX` | 255 | Maximum PWM value |
| `OBSTACLE_DISTANCE_CM` | 20 | Obstacle detection threshold |
| `LINE_THRESHOLD_WHITE` | 250 | Line sensor white threshold |
| `LINE_THRESHOLD_BLACK` | 850 | Line sensor black threshold |
| `BATTERY_LOW_VOLTAGE` | 7.0V | Low battery warning |

## Uploading

1. Open `SmartCarModified.ino` in Arduino IDE
2. Select Board: "Arduino Nano"
3. Select Processor: "ATmega328P" (or "ATmega328P (Old Bootloader)")
4. Select your COM port
5. Upload

## Original Stock Firmware

The unmodified stock firmware is preserved at:
```
firmware/arduino/SmartRobotCarV4.0_TB6612_MPU6050/
```
