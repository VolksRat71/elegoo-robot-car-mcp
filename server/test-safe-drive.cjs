// Test safe drive with obstacle detection
const net = require('net');

const socket = new net.Socket();

console.log('=== Safe Drive Test ===');
console.log('1. First we check for obstacles');
console.log('2. If clear, robot moves forward briefly');
console.log('3. Put your hand in front to test obstacle detection\n');

socket.connect(100, '192.168.4.1', () => {
  console.log('Connected!\n');

  // Enter standby
  socket.write('{"H":"1","N":100}\n');

  setTimeout(() => {
    console.log('Checking for obstacle...');
    socket.write('{"H":"1","N":21,"D1":1}\n');
  }, 500);
});

let obstacleChecked = false;

socket.on('data', (data) => {
  const msgs = data.toString().trim().split('\n');
  for (const msg of msgs) {
    if (!msg || msg === '{Heartbeat}') continue;

    console.log('Response:', msg);

    // Check obstacle response
    if (msg.includes('_true') && !obstacleChecked) {
      obstacleChecked = true;
      console.log('\n>>> OBSTACLE DETECTED! Not moving.\n');
      setTimeout(() => socket.destroy(), 1000);
    } else if (msg.includes('_false') && !obstacleChecked) {
      obstacleChecked = true;
      console.log('\n>>> Path clear! Moving forward for 1 second...\n');

      // Move forward
      socket.write('{"H":"1","N":3,"D1":0,"D2":150}\n');

      // Stop after 1 second
      setTimeout(() => {
        console.log('Stopping...');
        socket.write('{"H":"1","N":3,"D1":8,"D2":0}\n');
        setTimeout(() => socket.destroy(), 500);
      }, 1000);
    }
  }
});

socket.on('error', (err) => console.error('Error:', err.message));
socket.on('close', () => {
  console.log('\nTest complete!');
  process.exit(0);
});
