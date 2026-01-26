# Firmware Slimming & Ultrasonic Sensor Fix

**Date:** 2026-01-26

## Summary

Reduced Arduino firmware from 31KB (96%) to 21KB (65%) by removing unused features. Fixed ultrasonic sensor to return actual distance values instead of boolean detection.

## Changes Made

### MCP Server (`server/src/robot-client-stock.ts`)

1. **Ultrasonic now returns actual cm values**
   - Changed from `D1=1` (boolean) to `D1=2` (numeric distance)
   - Parses response format `{1_XX}` where XX is distance in cm
   - Falls back to `D1=1` if firmware doesn't support `D1=2`
   - Added smoothing to reject jumps >40cm (70/30 weighted average)

2. **Connection stability improvements**
   - Commands now wait for reconnection (up to 5s) instead of failing immediately
   - Reconnection tries immediately, then every 2 seconds
   - Socket close event guarded against spurious reconnects

### Arduino Firmware (`firmware/arduino/SmartCarModified/`)

#### Deleted Files (unused libraries)
- `IRremote.cpp`, `IRremote.h`, `IRremoteInt.h`
- `MPU6050.cpp`, `MPU6050.h`
- `MPU6050_getdata.cpp`, `MPU6050_getdata.h`
- `I2Cdev.cpp`, `I2Cdev.h`

#### Removed Features
- **IR Remote** - Not needed for MCP control
- **MPU6050 Gyro** - Yaw correction removed, motors run at equal speeds
- **Follow Mode** - Ultrasonic-based following
- **Rocker Mode** - App joystick control
- **Key Command** - Physical button mode switching
- **Lighting Commands** - Complex LED patterns (N=7, N=8)

#### Simplified Features
- **RGB LED** - Now simple status indicator:
  - Green = Standby (ready)
  - Yellow = Line tracking
  - Orange = Obstacle avoidance
  - Blue = Active/other
  - Red blink = Low battery

- **Linear Motion Control** - Removed gyro-based drift correction, direct motor control

#### Ultrasonic Improvements
- 5 samples with median filtering (was single reading)
- Discards invalid readings (0 or >150cm)
- 15ms between pings for HC-SR04 recovery time

### Size Comparison

| Metric | Before | After | Saved |
|--------|--------|-------|-------|
| Flash | 31,172 bytes (96%) | 21,150 bytes (65%) | ~10KB |
| RAM | 1,169 bytes (57%) | 606 bytes (29%) | ~560 bytes |

## Known Issues

### HC-SR04 Ultrasonic Sensor
The stock HC-SR04 ultrasonic sensor is unreliable:
- Inconsistent readings even with median filtering
- Can report 4cm then 100cm for same object distance
- Not suitable for precise navigation

**Solution:** Ordering VL53L1X Time-of-Flight sensor as replacement. Will require:
- I2C connection (A4/A5 pins, freed up from MPU6050 removal)
- New driver code in `DeviceDriverSet_xxx0.cpp`
- Update `CMD_UltrasoundModuleStatus_xxx0` to use ToF instead

## Files Modified

```
server/src/robot-client-stock.ts     # Ultrasonic parsing, connection stability
firmware/arduino/SmartCarModified/
├── SmartCarModified.ino             # Removed unused loop calls
├── ApplicationFunctionSet_xxx0.cpp  # Removed IR, Follow, Rocker, KeyCommand, Lighting
├── ApplicationFunctionSet_xxx0.h    # Removed function declarations
├── DeviceDriverSet_xxx0.cpp         # Removed IR driver, improved ultrasonic
├── DeviceDriverSet_xxx0.h           # Removed IR class
└── config.h                         # Removed IR remote codes
```

## Testing

```bash
# Flash firmware
cd firmware/arduino && make flash-modified

# Test MCP
cd server && npm run user:test
```

Verify:
- `drive` forward/backward/left/right/stop
- `get_distance` returns cm values (0-150)
- `look` 0/90/180 moves servo
- LED shows green in standby, blue when driving
