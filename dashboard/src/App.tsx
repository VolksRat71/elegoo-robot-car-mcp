import { useEffect, useState, useCallback } from 'react';
import { VisionPanel } from './components/VisionPanel';
import { DetectionsPanel } from './components/DetectionsPanel';
import { ControlPanel } from './components/ControlPanel';
import { StatusPanel } from './components/StatusPanel';
import { fetchSnapshot } from './api';
import type { Snapshot } from './types';

const POLL_INTERVAL = 1500; // 1.5 seconds

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);

  const loadSnapshot = useCallback(async () => {
    if (isPaused) return;

    try {
      const data = await fetchSnapshot();
      setSnapshot(data);
      setLastUpdate(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  }, [isPaused]);

  useEffect(() => {
    loadSnapshot();
    const interval = setInterval(loadSnapshot, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [loadSnapshot]);

  const handleCommandStart = () => {
    setIsPaused(true);
  };

  const handleCommandEnd = () => {
    setTimeout(() => {
      setIsPaused(false);
      loadSnapshot();
    }, 500);
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden p-4">
      {/* Header - compact */}
      <header className="flex-shrink-0 mb-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              AI Vision Lab
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              Elegoo Robot Car / Computer Vision Dashboard
            </p>
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <div className="px-2 py-1 bg-[var(--accent-red)]/10 border border-[var(--accent-red)]/30 rounded text-[var(--accent-red)] text-xs">
                {error}
              </div>
            )}
            <button
              onClick={() => setIsPaused(!isPaused)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                isPaused
                  ? 'bg-[var(--accent-orange)]/10 border border-[var(--accent-orange)] text-[var(--accent-orange)]'
                  : 'bg-[var(--bg-tertiary)] border border-[var(--border-primary)] text-[var(--text-secondary)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)]'
              }`}
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <span className="text-xs text-[var(--text-muted)] font-mono">
              v{snapshot?.world_state?.schema_version || '?'}
            </span>
          </div>
        </div>
        <div className="mt-2 h-px bg-gradient-to-r from-[var(--accent-cyan)]/50 via-[var(--border-primary)] to-transparent" />
      </header>

      {/* Main content - fills remaining space */}
      <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
        {/* Vision panels (Camera + Depth) - 8 cols */}
        <div className="col-span-8 min-h-0">
          <VisionPanel
            cameraImage={snapshot?.camera_image}
            depthImage={snapshot?.depth_image}
            annotatedImage={snapshot?.annotated_image}
            depth={snapshot?.depth}
            detections={snapshot?.detection?.detected_objects}
            isLoading={isLoading && !snapshot}
          />
        </div>

        {/* Right column: Status + Detections stacked - 4 cols */}
        <div className="col-span-4 flex flex-col gap-3 min-h-0">
          <div className="flex-shrink-0">
            <StatusPanel
              worldState={snapshot?.world_state}
              robotConnected={snapshot?.robot_connected ?? false}
              visionAvailable={snapshot?.vision_available ?? false}
              lastUpdate={lastUpdate ?? undefined}
            />
          </div>
          <div className="flex-1 min-h-0">
            <DetectionsPanel
              detections={snapshot?.detection?.detected_objects ?? []}
              placeTags={snapshot?.world_state?.semantics?.current_place_tags ?? []}
            />
          </div>
        </div>
      </div>

      {/* Slide-out Controls Panel */}
      <div
        className={`fixed top-1/2 -translate-y-1/2 right-0 z-50 transition-transform duration-300 ${
          controlsOpen ? 'translate-x-0' : 'translate-x-[calc(100%-40px)]'
        }`}
      >
        {/* Tab */}
        <button
          onClick={() => setControlsOpen(!controlsOpen)}
          className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full bg-[var(--bg-panel)] border border-r-0 border-[var(--border-primary)] rounded-l-lg px-2 py-6 hover:border-[var(--accent-cyan)] transition-colors"
        >
          <span className="writing-mode-vertical text-xs font-semibold text-[var(--accent-cyan)] tracking-wider">
            {controlsOpen ? 'CLOSE' : 'CONTROLS'}
          </span>
        </button>
        {/* Panel */}
        <div className="bg-[var(--bg-panel)] border border-[var(--border-primary)] rounded-l-lg shadow-2xl">
          <ControlPanel
            onCommandStart={handleCommandStart}
            onCommandEnd={handleCommandEnd}
            disabled={!snapshot?.robot_connected}
            compact
          />
        </div>
      </div>
    </div>
  );
}

export default App;
