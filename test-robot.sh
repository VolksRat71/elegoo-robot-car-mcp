#!/bin/bash
# Test script for Elegoo robot connection
# Run this while connected to ELEGOO-xxxx WiFi

RESULTS_FILE="$HOME/Desktop/robot-test-results.txt"
ROBOT_IP="192.168.4.1"

echo "Elegoo Robot Connection Test" > "$RESULTS_FILE"
echo "=============================" >> "$RESULTS_FILE"
echo "Date: $(date)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

# Test 1: Ping
echo "Testing ping..."
echo "=== PING TEST ===" >> "$RESULTS_FILE"
ping -c 3 $ROBOT_IP >> "$RESULTS_FILE" 2>&1
echo "" >> "$RESULTS_FILE"

# Test 2: Port 100 (TCP control)
echo "Testing port 100 (control)..."
echo "=== PORT 100 TEST ===" >> "$RESULTS_FILE"
nc -z -v -w 3 $ROBOT_IP 100 >> "$RESULTS_FILE" 2>&1
echo "" >> "$RESULTS_FILE"

# Test 3: Port 80 (HTTP/camera)
echo "Testing port 80 (HTTP)..."
echo "=== PORT 80 TEST ===" >> "$RESULTS_FILE"
nc -z -v -w 3 $ROBOT_IP 80 >> "$RESULTS_FILE" 2>&1
echo "" >> "$RESULTS_FILE"

# Test 4: Try to get camera page
echo "Testing camera HTTP endpoint..."
echo "=== CAMERA HTTP TEST ===" >> "$RESULTS_FILE"
curl -s -m 5 "http://$ROBOT_IP/" >> "$RESULTS_FILE" 2>&1
echo "" >> "$RESULTS_FILE"

# Test 5: Send stop command to port 100
echo "Sending stop command..."
echo "=== STOP COMMAND TEST ===" >> "$RESULTS_FILE"
echo '{"H":1,"N":0,"D1":0,"D2":0,"D3":0}' | nc -w 2 $ROBOT_IP 100 >> "$RESULTS_FILE" 2>&1
echo "" >> "$RESULTS_FILE"

# Test 6: Send forward command briefly
echo "Sending forward command (1 second)..."
echo "=== FORWARD COMMAND TEST ===" >> "$RESULTS_FILE"
echo '{"H":1,"N":1,"D1":0,"D2":0,"D3":0}' | nc -w 1 $ROBOT_IP 100 >> "$RESULTS_FILE" 2>&1
sleep 1
echo '{"H":1,"N":0,"D1":0,"D2":0,"D3":0}' | nc -w 1 $ROBOT_IP 100 >> "$RESULTS_FILE" 2>&1
echo "Sent forward then stop" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

echo "=== TEST COMPLETE ===" >> "$RESULTS_FILE"
echo ""
echo "Done! Results saved to: $RESULTS_FILE"
echo "Reconnect to regular WiFi and share the results with Claude."
