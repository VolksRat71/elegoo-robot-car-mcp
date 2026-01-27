import type { Snapshot, CommandResult } from './types';

const API_BASE = '/api';

export async function fetchSnapshot(): Promise<Snapshot> {
  const response = await fetch(`${API_BASE}/snapshot`);
  if (!response.ok) {
    throw new Error(`Failed to fetch snapshot: ${response.statusText}`);
  }
  return response.json();
}

export async function sendCommand(
  command: 'drive' | 'turn' | 'stop' | 'explore',
  params?: Record<string, unknown>
): Promise<CommandResult> {
  const response = await fetch(`${API_BASE}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, params }),
  });
  if (!response.ok) {
    throw new Error(`Command failed: ${response.statusText}`);
  }
  return response.json();
}

export async function drive(
  direction: 'forward' | 'backward' | 'left' | 'right' | 'stop',
  speed = 50,
  duration_ms = 500
): Promise<CommandResult> {
  return sendCommand('drive', { direction, speed, duration_ms });
}

export async function turn(degrees: number, speed = 40): Promise<CommandResult> {
  return sendCommand('turn', { degrees, speed });
}

export async function stop(): Promise<CommandResult> {
  return sendCommand('stop');
}

export async function explore(duration_s = 10): Promise<CommandResult> {
  return sendCommand('explore', { duration_s });
}
