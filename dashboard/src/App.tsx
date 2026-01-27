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
    <div className="min-h-screen p-6">
      {/* Header */}
      <header className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
              AI Vision Lab
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              Elegoo Robot Car / Computer Vision Dashboard
            </p>
          </div>
          <div className="flex items-center gap-4">
            {error && (
              <div className="px-3 py-1.5 bg-[var(--accent-red)]/10 border border-[var(--accent-red)]/30 rounded text-[var(--accent-red)] text-sm">
                {error}
              </div>
            )}
            <button
              onClick={() => setIsPaused(!isPaused)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                isPaused
                  ? 'bg-[var(--accent-orange)]/10 border border-[var(--accent-orange)] text-[var(--accent-orange)]'
                  : 'bg-[var(--bg-tertiary)] border border-[var(--border-primary)] text-[var(--text-secondary)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)]'
              }`}
            >
              {isPaused ? 'Resume Updates' : 'Pause Updates'}
            </button>
            <button
              onClick={loadSnapshot}
              disabled={isLoading}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--bg-tertiary)] border border-[var(--border-primary)] text-[var(--text-secondary)] hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] transition-all disabled:opacity-50"
            >
              {isLoading ? 'Loading...' : 'Refresh Now'}
            </button>
          </div>
        </div>

        {/* Decorative line */}
        <div className="mt-4 h-px bg-gradient-to-r from-[var(--accent-cyan)]/50 via-[var(--border-primary)] to-transparent" />
      </header>

      {/* Main content */}
      <div className="grid grid-cols-12 gap-4">
        {/* Vision panels - left 8 columns */}
        <div className="col-span-8 space-y-4">
          <VisionPanel
            cameraImage={snapshot?.camera_image}
            depthImage={snapshot?.depth_image}
            annotatedImage={snapshot?.annotated_image}
            depth={snapshot?.depth}
            detections={snapshot?.detection?.detected_objects}
            isLoading={isLoading && !snapshot}
          />
        </div>

        {/* Right sidebar - 4 columns */}
        <div className="col-span-4 space-y-4">
          <StatusPanel
            worldState={snapshot?.world_state}
            robotConnected={snapshot?.robot_connected ?? false}
            visionAvailable={snapshot?.vision_available ?? false}
            lastUpdate={lastUpdate ?? undefined}
          />
          <DetectionsPanel
            detections={snapshot?.detection?.detected_objects ?? []}
            placeTags={snapshot?.world_state?.semantics?.current_place_tags ?? []}
          />
        </div>

        {/* Controls - bottom */}
        <div className="col-span-12">
          <ControlPanel
            onCommandStart={handleCommandStart}
            onCommandEnd={handleCommandEnd}
            disabled={!snapshot?.robot_connected}
          />
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-6 pt-4 border-t border-[var(--border-primary)]">
        <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>STEM Robotics Project</span>
          <span className="font-mono">
            Schema v{snapshot?.world_state?.schema_version || '?.?'}
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
