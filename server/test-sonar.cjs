// Test ultrasonic sensor - reads every second for 10 seconds
const net = require('net');

const socket = new net.Socket();
let readCount = 0;

socket.connect(100, '192.168.4.1', () => {
  console.log('Connected to robot');
  console.log('Place your hand at different distances in front of the ultrasonic sensor...\n');

  // Read every second
  const interval = setInterval(() => {
    readCount++;
    socket.write('{"H":"1","N":21,"D1":2}\n');

    if (readCount >= 10) {
      clearInterval(interval);
      setTimeout(() => {
        socket.destroy();
        process.exit(0);
      }, 500);
    }
  }, 1000);
});

socket.on('data', (data) => {
  const msg = data.toString().trim();
  if (msg !== '{Heartbeat}') {
    // Parse distance from {1_XX} format
    const match = msg.match(/\{1[_:](\d+)\}/);
    if (match) {
      const distance = parseInt(match[1], 10);
      const bar = '='.repeat(Math.min(distance / 2, 50));
      console.log(`Distance: ${distance.toString().padStart(3)} cm |${bar}`);
    } else {
      console.log('Response:', msg);
    }
  }
});

socket.on('error', (err) => {
  console.error('Error:', err.message);
});

