#!/usr/bin/env python3
"""
Connection diagnostics for Elegoo robot car.
Measures latency, packet loss, and connection stability.

Usage:
    python connection_diagnostics.py [--duration 60] [--interval 0.5]
"""

import argparse
import json
import socket
import statistics
import sys
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ConnectionMetrics:
    """Accumulated connection metrics."""
    commands_sent: int = 0
    commands_success: int = 0
    commands_failed: int = 0
    commands_timeout: int = 0

    latencies_ms: list = field(default_factory=list)

    connection_drops: int = 0
    reconnections: int = 0

    start_time: float = 0.0
    last_success_time: float = 0.0
    longest_gap_ms: float = 0.0

    def success_rate(self) -> float:
        if self.commands_sent == 0:
            return 0.0
        return (self.commands_success / self.commands_sent) * 100

    def avg_latency_ms(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return statistics.mean(self.latencies_ms)

    def p50_latency_ms(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return statistics.median(self.latencies_ms)

    def p95_latency_ms(self) -> float:
        if len(self.latencies_ms) < 2:
            return self.avg_latency_ms()
        sorted_latencies = sorted(self.latencies_ms)
        idx = int(len(sorted_latencies) * 0.95)
        return sorted_latencies[idx]

    def p99_latency_ms(self) -> float:
        if len(self.latencies_ms) < 2:
            return self.avg_latency_ms()
        sorted_latencies = sorted(self.latencies_ms)
        idx = int(len(sorted_latencies) * 0.99)
        return sorted_latencies[idx]

    def min_latency_ms(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return min(self.latencies_ms)

    def max_latency_ms(self) -> float:
        if not self.latencies_ms:
            return 0.0
        return max(self.latencies_ms)


class DiagnosticClient:
    """TCP client for connection diagnostics.

    ESP32 firmware limitation: Can only handle ~4-5 messages per connection.
    We proactively reconnect every 3 commands to get accurate metrics.
    """

    # ESP32 can handle ~4-5 commands per connection, reconnect at 3 to be safe
    COMMANDS_PER_CONNECTION = 3

    def __init__(self, host: str = "192.168.4.1", port: int = 100):
        self.host = host
        self.port = port
        self.socket: Optional[socket.socket] = None
        self.metrics = ConnectionMetrics(start_time=time.time())
        self.commands_since_connect = 0

    def connect(self) -> bool:
        """Establish TCP connection."""
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(2.0)
            self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.socket.connect((self.host, self.port))
            print(f"[DIAG] Connected to {self.host}:{self.port}")
            self.commands_since_connect = 0
            return True
        except Exception as e:
            print(f"[DIAG] Connection failed: {e}")
            return False

    def disconnect(self):
        """Close TCP connection."""
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
            self.socket = None
        self.commands_since_connect = 0

    def reconnect(self) -> bool:
        """Attempt reconnection."""
        self.disconnect()
        self.metrics.reconnections += 1
        return self.connect()

    def _ensure_fresh_connection(self) -> bool:
        """Reconnect if we've sent too many commands on this connection."""
        if self.commands_since_connect >= self.COMMANDS_PER_CONNECTION:
            self.disconnect()
            return self.connect()
        return self.socket is not None

    def ping(self, timeout: float = 1.0) -> Optional[float]:
        """
        Send a command and measure round-trip time.
        Uses GROUND_CHECK (N=23) as a lightweight ping.
        Returns latency in ms, or None on failure.
        """
        # Proactively reconnect to avoid ESP32 connection limit
        if not self._ensure_fresh_connection():
            return None

        # Build command (ground check - lightweight status query)
        cmd = json.dumps({"H": "1", "N": 23, "D1": 0, "D2": 0, "D3": 0}) + "\n"

        self.metrics.commands_sent += 1
        start = time.perf_counter()

        try:
            self.socket.settimeout(timeout)
            self.socket.sendall(cmd.encode())
            self.commands_since_connect += 1

            # Wait for response
            response = self.socket.recv(1024)

            elapsed_ms = (time.perf_counter() - start) * 1000

            if response:
                self.metrics.commands_success += 1
                self.metrics.latencies_ms.append(elapsed_ms)

                # Track gaps between successes
                now = time.time()
                if self.metrics.last_success_time > 0:
                    gap = (now - self.metrics.last_success_time) * 1000
                    if gap > self.metrics.longest_gap_ms:
                        self.metrics.longest_gap_ms = gap
                self.metrics.last_success_time = now

                return elapsed_ms
            else:
                self.metrics.commands_failed += 1
                return None

        except socket.timeout:
            self.metrics.commands_timeout += 1
            return None
        except Exception as e:
            self.metrics.commands_failed += 1
            self.metrics.connection_drops += 1
            return None

    def run_diagnostics(self, duration_s: float = 60, interval_s: float = 0.5):
        """Run continuous diagnostics for specified duration."""

        if not self.connect():
            print("[DIAG] Could not establish initial connection")
            return

        end_time = time.time() + duration_s
        last_print = time.time()
        print_interval = 5.0  # Print summary every 5 seconds

        print(f"\n[DIAG] Running diagnostics for {duration_s}s (interval: {interval_s}s)")
        print("-" * 70)

        consecutive_failures = 0
        max_consecutive_failures = 5

        try:
            while time.time() < end_time:
                latency = self.ping()

                if latency is not None:
                    consecutive_failures = 0
                    status = f"✓ {latency:6.1f}ms"
                else:
                    consecutive_failures += 1
                    if consecutive_failures >= max_consecutive_failures:
                        print(f"[DIAG] {consecutive_failures} consecutive failures, reconnecting...")
                        if self.reconnect():
                            consecutive_failures = 0
                        else:
                            print("[DIAG] Reconnection failed, waiting...")
                            time.sleep(2.0)
                            continue
                    status = "✗ FAIL"

                # Print individual ping results
                print(f"[PING] {status}  |  sent:{self.metrics.commands_sent} "
                      f"ok:{self.metrics.commands_success} "
                      f"fail:{self.metrics.commands_failed} "
                      f"timeout:{self.metrics.commands_timeout}")

                # Print periodic summary
                if time.time() - last_print >= print_interval:
                    self._print_summary()
                    last_print = time.time()

                time.sleep(interval_s)

        except KeyboardInterrupt:
            print("\n[DIAG] Interrupted")
        finally:
            self.disconnect()
            print("\n" + "=" * 70)
            self._print_final_report()

    def _print_summary(self):
        """Print periodic summary."""
        m = self.metrics
        print("-" * 70)
        print(f"[SUMMARY] Success: {m.success_rate():.1f}%  |  "
              f"Latency: avg={m.avg_latency_ms():.1f}ms p50={m.p50_latency_ms():.1f}ms "
              f"p95={m.p95_latency_ms():.1f}ms  |  Drops: {m.connection_drops}")
        print("-" * 70)

    def _print_final_report(self):
        """Print final diagnostic report."""
        m = self.metrics
        elapsed = time.time() - m.start_time

        print("FINAL DIAGNOSTIC REPORT")
        print("=" * 70)
        print(f"\nDuration: {elapsed:.1f}s")
        print(f"\nCommands:")
        print(f"  Total sent:     {m.commands_sent}")
        print(f"  Successful:     {m.commands_success}")
        print(f"  Failed:         {m.commands_failed}")
        print(f"  Timeouts:       {m.commands_timeout}")
        print(f"  Success rate:   {m.success_rate():.1f}%")

        print(f"\nLatency (ms):")
        print(f"  Min:            {m.min_latency_ms():.1f}")
        print(f"  Avg:            {m.avg_latency_ms():.1f}")
        print(f"  P50 (median):   {m.p50_latency_ms():.1f}")
        print(f"  P95:            {m.p95_latency_ms():.1f}")
        print(f"  P99:            {m.p99_latency_ms():.1f}")
        print(f"  Max:            {m.max_latency_ms():.1f}")

        print(f"\nConnection stability:")
        print(f"  Drops:          {m.connection_drops}")
        print(f"  Reconnections:  {m.reconnections}")
        print(f"  Longest gap:    {m.longest_gap_ms:.1f}ms")

        # Recommendations
        print(f"\n" + "=" * 70)
        print("RECOMMENDATIONS")
        print("=" * 70)

        if m.success_rate() < 90:
            print("⚠️  High failure rate - check WiFi signal strength")
        if m.avg_latency_ms() > 100:
            print("⚠️  High latency - may affect real-time control")
        if m.p95_latency_ms() > 200:
            print("⚠️  High P95 latency - expect occasional sluggish responses")
        if m.connection_drops > 0:
            print(f"⚠️  {m.connection_drops} connection drops - unstable link")
        if m.longest_gap_ms > 2000:
            print(f"⚠️  Longest gap {m.longest_gap_ms:.0f}ms - may cause control issues")

        # Control loop recommendations
        print(f"\nControl loop timing recommendations:")
        safe_interval = max(m.p95_latency_ms() * 2, 200)
        print(f"  Minimum loop interval: {safe_interval:.0f}ms")
        print(f"  Recommended timeout:   {m.p99_latency_ms() * 1.5:.0f}ms")

        if m.success_rate() >= 95 and m.avg_latency_ms() < 50:
            print("\n✅ Connection quality: GOOD - suitable for autonomous driving")
        elif m.success_rate() >= 85 and m.avg_latency_ms() < 100:
            print("\n⚠️  Connection quality: FAIR - use cautious settings")
        else:
            print("\n❌ Connection quality: POOR - fix connection before driving")


def test_camera_connection(host: str = "192.168.4.1", port: int = 81) -> bool:
    """Quick test of camera stream availability."""
    try:
        import requests
        response = requests.get(f"http://{host}:{port}/stream", timeout=2.0, stream=True)
        # Just check if we can connect
        for chunk in response.iter_content(chunk_size=1024):
            if chunk:
                print(f"[CAMERA] Stream available at http://{host}:{port}/stream")
                return True
            break
        return False
    except Exception as e:
        print(f"[CAMERA] Stream not available: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Elegoo robot connection diagnostics")
    parser.add_argument("--duration", type=int, default=30, help="Test duration in seconds")
    parser.add_argument("--interval", type=float, default=0.5, help="Ping interval in seconds")
    parser.add_argument("--host", default="192.168.4.1", help="Robot IP address")
    parser.add_argument("--port", type=int, default=100, help="Robot TCP port")
    parser.add_argument("--camera-check", action="store_true", help="Also check camera stream")
    args = parser.parse_args()

    print("=" * 70)
    print("ELEGOO ROBOT CONNECTION DIAGNOSTICS")
    print("=" * 70)

    if args.camera_check:
        test_camera_connection(args.host)
        print()

    client = DiagnosticClient(args.host, args.port)
    client.run_diagnostics(args.duration, args.interval)


if __name__ == "__main__":
    main()
