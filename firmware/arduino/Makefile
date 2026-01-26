# Elegoo Smart Robot Car V4.0 - Firmware Build System
# Usage:
#   make compile-stock      - Compile stock firmware
#   make compile-modified   - Compile modified firmware
#   make flash-stock        - Flash stock firmware to robot
#   make flash-modified     - Flash modified firmware to robot
#   make ports              - List available serial ports
#   make monitor            - Open serial monitor (9600 baud)

# ============================================================================
# Configuration
# ============================================================================

# Board settings
# Elegoo Smart Robot Car V4.0 uses Arduino Uno (Nano doesn't have enough flash)
# If upload fails with Uno, try: BOARD = arduino:avr:mega:cpu=atmega2560
BOARD = arduino:avr:uno

# Compiler flags for size optimization
# FastLED: disable unused chipsets since we only use WS2812 (NeoPixel)
BUILD_FLAGS = --build-property "build.extra_flags=-DFASTLED_ALLOW_INTERRUPTS=0"

# Serial port - auto-detect USB serial or override with: make flash-modified PORT=/dev/cu.xxx
PORT ?= $(shell ls /dev/cu.usbserial-* 2>/dev/null | head -1)

# Baud rate for serial monitor
BAUD = 9600

# Firmware directories (folder name must match .ino filename)
STOCK_DIR = SmartRobotCarV4.0_TB6612_MPU6050
MODIFIED_DIR = SmartCarModified

# Build output directory
BUILD_DIR = build

# ============================================================================
# Targets
# ============================================================================

.PHONY: all compile-stock compile-modified flash-stock flash-modified ports monitor clean help

# Default target
all: help

# Compile stock firmware
compile-stock:
	@echo "Compiling stock firmware..."
	arduino-cli compile --fqbn $(BOARD) $(BUILD_FLAGS) --build-path $(BUILD_DIR)/stock $(STOCK_DIR)
	@echo "✓ Stock firmware compiled successfully"

# Compile modified firmware
compile-modified:
	@echo "Compiling modified firmware..."
	arduino-cli compile --fqbn $(BOARD) $(BUILD_FLAGS) --build-path $(BUILD_DIR)/modified $(MODIFIED_DIR)
	@echo "✓ Modified firmware compiled successfully"

# Flash stock firmware
flash-stock: check-port compile-stock
	@echo "Flashing stock firmware to $(PORT)..."
	arduino-cli upload --fqbn $(BOARD) --port $(PORT) --input-dir $(BUILD_DIR)/stock
	@echo "✓ Stock firmware flashed successfully"

# Flash modified firmware
flash-modified: check-port compile-modified
	@echo "Flashing modified firmware to $(PORT)..."
	arduino-cli upload --fqbn $(BOARD) --port $(PORT) --input-dir $(BUILD_DIR)/modified
	@echo "✓ Modified firmware flashed successfully"

# Compile both (useful for CI/validation)
compile-all: compile-stock compile-modified
	@echo "✓ All firmware variants compiled"

# List available serial ports
ports:
	@echo "Available serial ports:"
	@arduino-cli board list

# Open serial monitor
monitor: check-port
	@echo "Opening serial monitor on $(PORT) at $(BAUD) baud..."
	@echo "(Press Ctrl+C to exit)"
	arduino-cli monitor --port $(PORT) --config baudrate=$(BAUD)

# Clean build artifacts
clean:
	@echo "Cleaning build directory..."
	rm -rf $(BUILD_DIR)
	@echo "✓ Clean complete"

# Check if port is set
check-port:
ifndef PORT
	$(error No serial port found. Connect your Arduino or specify PORT=/dev/cu.xxx)
endif
	@test -e $(PORT) || (echo "Error: Port $(PORT) not found" && exit 1)

# Install required Arduino core (run once)
setup:
	@echo "Installing Arduino AVR core..."
	arduino-cli core update-index
	arduino-cli core install arduino:avr
	@echo "✓ Setup complete"

# Help
help:
	@echo "Elegoo Smart Robot Car V4.0 - Firmware Build System"
	@echo ""
	@echo "Usage:"
	@echo "  make compile-stock      Compile stock firmware (no changes)"
	@echo "  make compile-modified   Compile modified firmware (pins.h/config.h)"
	@echo "  make flash-stock        Compile and flash stock firmware"
	@echo "  make flash-modified     Compile and flash modified firmware"
	@echo "  make compile-all        Compile both variants"
	@echo "  make ports              List available serial ports"
	@echo "  make monitor            Open serial monitor (9600 baud)"
	@echo "  make clean              Remove build artifacts"
	@echo "  make setup              Install Arduino AVR core"
	@echo ""
	@echo "Options:"
	@echo "  PORT=/dev/cu.xxx        Override auto-detected serial port"
	@echo "  BOARD=arduino:avr:nano:cpu=atmega328old   Use old bootloader"
	@echo ""
	@echo "Examples:"
	@echo "  make flash-modified"
	@echo "  make flash-modified PORT=/dev/cu.usbserial-1140"
	@echo "  make flash-stock BOARD=arduino:avr:nano:cpu=atmega328old"
