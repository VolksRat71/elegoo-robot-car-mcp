// Debug test script for stock Elegoo robot
const net = require('net');

const ROBOT_IP = '192.168.4.1';
const ROBOT_PORT = 100;

const socket = new net.Socket();

function send(cmd, description) {
  const msg = JSON.stringify(cmd) + '\n';
  console.log(`[SEND] ${description}: ${msg.trim()}`);
  socket.write(msg);
}

socket.connect(ROBOT_PORT, ROBOT_IP, () => {
  console.log('=== Connected to robot ===\n');

  // N=1: Motor control - D1=motor(0=all), D2=speed(0-250), D3=direction(1=fwd,2=back,0=stop)

  // First: Clear all functions, enter standby (N=100)
  setTimeout(() => {
    send({ H: "1", N: 100 }, 'Clear functions - enter standby mode');
  }, 300);

  // Check if car thinks it's off ground (N=23)
  setTimeout(() => {
    send({ H: "1", N: 23 }, 'Check ground status');
  }, 600);

  // Forward: all motors, MAX speed 250, direction forward
  setTimeout(() => {
    send({ H: "1", N: 1, D1: 0, D2: 250, D3: 1 }, 'FORWARD: all motors, speed 250, dir=1');
  }, 1000);

  // Stop after 2 seconds
  setTimeout(() => {
    send({ H: "1", N: 1, D1: 0, D2: 0, D3: 0 }, 'STOP: all motors, speed 0, dir=0');
  }, 2500);

  // Try backward
  setTimeout(() => {
    send({ H: "1", N: 1, D1: 0, D2: 150, D3: 2 }, 'BACKWARD: all motors, speed 150, dir=2');
  }, 3500);

  // Final stop
  setTimeout(() => {
    send({ H: "1", N: 1, D1: 0, D2: 0, D3: 0 }, 'STOP');
    setTimeout(() => {
      console.log('\n=== Test complete ===');
      socket.destroy();
    }, 500);
  }, 5500);
});

socket.on('data', (data) => {
  console.log(`[RECV] ${data.toString().trim()}`);
});

socket.on('error', (err) => {
  console.error('[ERROR]', err.message);
});

socket.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});
