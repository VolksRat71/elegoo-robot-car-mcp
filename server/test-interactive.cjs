// Interactive test - monitor robot and send commands
const net = require('net');
const readline = require('readline');

const socket = new net.Socket();

socket.connect(100, '192.168.4.1', () => {
  console.log('Connected! Type commands (JSON format) or try these:');
  console.log('  1 = forward   2 = backward   3 = left   4 = right   0 = stop');
  console.log('  q = quit\n');
});

socket.on('data', (data) => {
  console.log(`[ROBOT] ${data.toString().trim()}`);
});

socket.on('error', (err) => console.error('[ERROR]', err.message));
socket.on('close', () => { console.log('Connection closed'); process.exit(0); });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (input) => {
  const cmd = input.trim();
  if (cmd === 'q') { socket.destroy(); return; }

  let msg;
  if (cmd === '0') msg = { H: 1, N: 0, D1: 0, D2: 0, D3: 0 };
  else if (cmd === '1') msg = { H: 1, N: 1, D1: 200, D2: 200, D3: 0 };
  else if (cmd === '2') msg = { H: 1, N: 2, D1: 200, D2: 200, D3: 0 };
  else if (cmd === '3') msg = { H: 1, N: 3, D1: 200, D2: 200, D3: 0 };
  else if (cmd === '4') msg = { H: 1, N: 4, D1: 200, D2: 200, D3: 0 };
  else {
    try { msg = JSON.parse(cmd); }
    catch { console.log('Invalid JSON. Use numbers 0-4 or raw JSON.'); return; }
  }

  const str = JSON.stringify(msg);
  socket.write(str + '\n');
  console.log(`[SENT] ${str}`);
});
