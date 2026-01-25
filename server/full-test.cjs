const net = require('net');

const socket = new net.Socket();

const tests = [
  { cmd: { H: "1", N: 100 }, desc: "N=100: Enter standby mode", delay: 1000 },
  { cmd: { H: "1", N: 5, D1: 1, D2: 90 }, desc: "N=5: Servo 1 to 90 degrees (camera pan)", delay: 1500 },
  { cmd: { H: "1", N: 5, D1: 1, D2: 45 }, desc: "N=5: Servo 1 to 45 degrees", delay: 1500 },
  { cmd: { H: "1", N: 5, D1: 1, D2: 135 }, desc: "N=5: Servo 1 to 135 degrees", delay: 1500 },
  { cmd: { H: "1", N: 5, D1: 1, D2: 90 }, desc: "N=5: Servo back to center", delay: 1500 },
  { cmd: { H: "1", N: 8, D1: 0, D2: 255, D3: 0, D4: 0 }, desc: "N=8: LEDs RED", delay: 1500 },
  { cmd: { H: "1", N: 8, D1: 0, D2: 0, D3: 255, D4: 0 }, desc: "N=8: LEDs GREEN", delay: 1500 },
  { cmd: { H: "1", N: 8, D1: 0, D2: 0, D3: 0, D4: 255 }, desc: "N=8: LEDs BLUE", delay: 1500 },
  { cmd: { H: "1", N: 8, D1: 0, D2: 0, D3: 0, D4: 0 }, desc: "N=8: LEDs OFF", delay: 1000 },
  { cmd: { H: "1", N: 21, D1: 1 }, desc: "N=21: Ultrasonic sensor read", delay: 1500 },
  { cmd: { H: "1", N: 22, D1: 1 }, desc: "N=22: Line tracking sensor read", delay: 1500 },
  { cmd: { H: "1", N: 3, D1: 0, D2: 250 }, desc: "N=3: FORWARD (D1=0, speed=250)", delay: 2500 },
  { cmd: { H: "1", N: 3, D1: 8, D2: 0 }, desc: "N=3: STOP", delay: 1000 },
  { cmd: { H: "1", N: 1, D1: 0, D2: 250, D3: 1 }, desc: "N=1: Motor all, speed=250, dir=1 (fwd)", delay: 2500 },
  { cmd: { H: "1", N: 1, D1: 0, D2: 0, D3: 0 }, desc: "N=1: Motor STOP", delay: 1000 },
  { cmd: { H: "1", N: 4, D1: 250, D2: 250 }, desc: "N=4: Motor speed L=250 R=250", delay: 2500 },
  { cmd: { H: "1", N: 4, D1: 0, D2: 0 }, desc: "N=4: Motor speed STOP", delay: 500 },
  { cmd: { H: "1", N: 100 }, desc: "N=100: Back to standby", delay: 500 },
];

let idx = 0;

socket.connect(100, '192.168.4.1', () => {
  console.log('=== COMPREHENSIVE ROBOT TEST ===\n');
  console.log('Watch the robot and note what happens for each test.\n');
  runNext();
});

function runNext() {
  if (idx >= tests.length) {
    console.log('\n=== ALL TESTS COMPLETE ===');
    console.log('Which tests caused visible reactions?');
    socket.destroy();
    return;
  }

  const test = tests[idx];
  const msg = JSON.stringify(test.cmd) + '\n';

  console.log('[TEST ' + (idx + 1) + '/' + tests.length + '] ' + test.desc);
  console.log('  Sending: ' + msg.trim());

  socket.write(msg);
  idx++;

  setTimeout(runNext, test.delay || 1000);
}

socket.on('data', d => {
  const resp = d.toString().trim();
  if (resp !== '{Heartbeat}') {
    console.log('  >>> Response: ' + resp);
  }
});

socket.on('error', e => console.log('Error:', e.message));
socket.on('close', () => process.exit(0));
