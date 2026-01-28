import { useEffect, useState, useCallback } from 'react';
import { CameraFeed } from './components/CameraFeed';
import { ControlPad } from './components/ControlPad';
import { Telemetry } from './components/Telemetry';
import { fetchSnapshot, fetchDecisions } from './api';
import type { Snapshot, Decision } from './types';

const POLL_INTERVAL = 1500;

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  // Copilot / decisions state
  const [copilotActive, setCopilotActive] = useState(false);
  const [decisions, setDecisions] = useState<Decision[]>([]);

  const loadData = useCallback(async () => {
    if (isPaused) return;

    try {
      // Fetch snapshot and decisions in parallel
      const [snapshotData, decisionsData] = await Promise.all([
        fetchSnapshot(),
        fetchDecisions().catch(() => null), // Don't fail if decisions endpoint unavailable
      ]);

      setSnapshot(snapshotData);
      setLastUpdate(Date.now());
      setError(null);

      if (decisionsData) {
        setCopilotActive(decisionsData.copilot_active);
        setDecisions(decisionsData.decisions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsLoading(false);
    }
  }, [isPaused]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleCommandStart = () => setIsPaused(true);
  const handleCommandEnd = () => {
    setTimeout(() => {
      setIsPaused(false);
      loadData();
    }, 500);
  };

  const handleDecisionsClear = () => {
    setDecisions([]);
    loadData();
  };

  return (
    <div className="h-screen flex flex-col p-4 gap-3">
      {/* Top Bar - Title + Status Strip */}
      <header className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="font-mono text-sm font-medium tracking-wider text-[var(--bp-cream)]">
            ELEGOO // VISION CONTROL
          </h1>
          <div className="h-4 w-px bg-[var(--bp-line-dim)]" />
          <div className="flex items-center gap-3">
            <StatusIndicator
              label="LINK"
              active={snapshot?.robot_connected ?? false}
            />
            <StatusIndicator
              label="CAM"
              active={snapshot?.vision_available ?? false}
              warning={!snapshot?.vision_available && !error}
            />
            {copilotActive && (
              <StatusIndicator
                label="COPILOT"
                active={true}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {error && (
            <span className="bp-tag error">{error}</span>
          )}
          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`bp-btn px-3 py-1 text-xs ${isPaused ? 'active' : ''}`}
          >
            {isPaused ? 'RESUME' : 'PAUSE'}
          </button>
          <span className="font-mono text-xs text-[var(--bp-cream-dim)]">
            v{snapshot?.world_state?.schema_version || '—'}
          </span>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* Left: Camera Feed (hero) */}
        <div className="flex-1 min-w-0">
          <CameraFeed
            cameraImage={snapshot?.camera_image}
            depthImage={snapshot?.depth_image}
            annotatedImage={snapshot?.annotated_image}
            depth={snapshot?.depth}
            detections={snapshot?.detection?.detected_objects}
            isLoading={isLoading && !snapshot}
          />
        </div>

        {/* Right: Controls + Telemetry */}
        <div className="w-72 flex flex-col gap-3 flex-shrink-0">
          <ControlPad
            onCommandStart={handleCommandStart}
            onCommandEnd={handleCommandEnd}
            disabled={!snapshot?.robot_connected}
            copilotActive={copilotActive}
            decisions={decisions}
            onDecisionsClear={handleDecisionsClear}
          />
          <Telemetry
            worldState={snapshot?.world_state}
            lastUpdate={lastUpdate ?? undefined}
            detections={snapshot?.detection?.detected_objects ?? []}
          />
        </div>
      </div>
    </div>
  );
}

function StatusIndicator({
  label,
  active,
  warning,
}: {
  label: string;
  active: boolean;
  warning?: boolean;
}) {
  const statusClass = active ? 'active' : warning ? 'warning' : 'error';
  return (
    <div className="bp-status">
      <div className={`bp-status-dot ${statusClass}`} />
      <span className="font-mono text-[10px] text-[var(--bp-cream-dim)]">{label}</span>
    </div>
  );
}

export default App;
