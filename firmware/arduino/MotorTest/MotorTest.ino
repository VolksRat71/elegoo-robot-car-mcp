/*
 * Minimal Motor Test for Elegoo V4 (v1.1 Shield)
 * This directly controls the motors bypassing all other code.
 * Motors should spin forward for 2 seconds, then backward for 2 seconds, repeat.
 */

// Motor pins for SmartCar-Shield-v1.1 with DRV8835 driver
#define PIN_Motor_PWMA 5   // Right motor speed (PWM)
#define PIN_Motor_PWMB 6   // Left motor speed (PWM)
#define PIN_Motor_STBY 8   // Standby - MUST be HIGH to enable motors!
#define PIN_Motor_BIN_1 7  // Left motor direction
#define PIN_Motor_AIN_1 9  // Right motor direction (was 8 on newer boards)

void setup() {
  Serial.begin(9600);
  Serial.println("Motor Test Starting (v1.1 Shield)...");

  // Set all motor pins as outputs
  pinMode(PIN_Motor_PWMA, OUTPUT);
  pinMode(PIN_Motor_PWMB, OUTPUT);
  pinMode(PIN_Motor_AIN_1, OUTPUT);
  pinMode(PIN_Motor_BIN_1, OUTPUT);
  pinMode(PIN_Motor_STBY, OUTPUT);

  // CRITICAL: Enable the motor driver by setting STBY HIGH
  digitalWrite(PIN_Motor_STBY, HIGH);
  Serial.println("STBY pin set HIGH - motor driver enabled");

  Serial.println("Pins configured");
}

void loop() {
  Serial.println("FORWARD - both motors");

  // Forward: AIN_1 and BIN_1 LOW
  digitalWrite(PIN_Motor_AIN_1, LOW);
  digitalWrite(PIN_Motor_BIN_1, LOW);

  // Set speed (0-255)
  analogWrite(PIN_Motor_PWMA, 200);
  analogWrite(PIN_Motor_PWMB, 200);

  delay(2000);

  // Stop
  Serial.println("STOP");
  analogWrite(PIN_Motor_PWMA, 0);
  analogWrite(PIN_Motor_PWMB, 0);

  delay(1000);

  Serial.println("BACKWARD - both motors");

  // Backward: AIN_1 and BIN_1 HIGH
  digitalWrite(PIN_Motor_AIN_1, HIGH);
  digitalWrite(PIN_Motor_BIN_1, HIGH);

  // Set speed
  analogWrite(PIN_Motor_PWMA, 200);
  analogWrite(PIN_Motor_PWMB, 200);

  delay(2000);

  // Stop
  Serial.println("STOP");
  analogWrite(PIN_Motor_PWMA, 0);
  analogWrite(PIN_Motor_PWMB, 0);

  delay(1000);
}
