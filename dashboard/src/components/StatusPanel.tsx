import type { WorldState } from '../types';

interface StatusPanelProps {
  worldState?: WorldState;
  robotConnected: boolean;
  visionAvailable: boolean;
  lastUpdate?: number;
}

export function StatusPanel({
  worldState,
  robotConnected,
  visionAvailable,
  lastUpdate,
}: StatusPanelProps) {
  const state = worldState?.autonomy_state || 'UNKNOWN';
  const safetyPercent = (worldState?.confidence.safety || 0) * 100;
  const frontDistance = worldState?.geometry.front_min_mm || 0;

  const getStateColor = (s: string) => {
    switch (s) {
      case 'IDLE':
        return 'var(--accent-cyan)';
      case 'EXECUTING':
        return 'var(--accent-green)';
      case 'AVOIDING':
      case 'RECOVERING':
        return 'var(--accent-orange)';
      case 'STUCK':
        return 'var(--accent-red)';
      default:
        return 'var(--text-muted)';
    }
  };

  const getSafetyColor = (percent: number) => {
    if (percent >= 70) return 'var(--accent-green)';
    if (percent >= 40) return 'var(--accent-yellow)';
    return 'var(--accent-red)';
  };

  const formatDistance = (mm: number) => {
    if (mm >= 1000) return `${(mm / 1000).toFixed(1)}m`;
    return `${mm}mm`;
  };

  return (
    <div className="panel">
      <div className="panel-header">System Status</div>
      <div className="p-3 space-y-2.5">
        {/* Connection status - compact row */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 flex-1">
            <div className={`status-dot ${robotConnected ? 'active' : 'error'}`} />
            <span className="text-xs">Robot</span>
            <span className={`text-[10px] font-mono ml-auto ${robotConnected ? 'text-[var(--accent-green)]' : 'text-[var(--accent-red)]'}`}>
              {robotConnected ? 'OK' : 'OFF'}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <div className={`status-dot ${visionAvailable ? 'active' : 'warning'}`} />
            <span className="text-xs">Vision</span>
            <span className={`text-[10px] font-mono ml-auto ${visionAvailable ? 'text-[var(--accent-green)]' : 'text-[var(--accent-orange)]'}`}>
              {visionAvailable ? 'OK' : '...'}
            </span>
          </div>
        </div>

        <div className="h-px bg-[var(--border-primary)]" />

        {/* Autonomy state + Safety in row */}
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="data-label text-[9px] mb-0.5">State</div>
            <div
              className="font-mono text-sm font-bold"
              style={{ color: getStateColor(state) }}
            >
              {state}
            </div>
          </div>
          <div className="flex-1">
            <div className="flex justify-between mb-0.5">
              <span className="data-label text-[9px]">Safety</span>
              <span
                className="font-mono text-[10px] font-semibold"
                style={{ color: getSafetyColor(safetyPercent) }}
              >
                {safetyPercent.toFixed(0)}%
              </span>
            </div>
            <div className="progress-bar h-1">
              <div
                className="progress-fill"
                style={{
                  width: `${safetyPercent}%`,
                  background: getSafetyColor(safetyPercent),
                }}
              />
            </div>
          </div>
        </div>

        {/* Front distance - compact */}
        <div>
          <div className="flex items-baseline justify-between">
            <span className="data-label text-[9px]">Front Distance</span>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-lg font-bold text-[var(--text-primary)]">
                {formatDistance(frontDistance)}
              </span>
              {frontDistance < 200 && frontDistance > 0 && (
                <span className="text-[9px] text-[var(--accent-orange)]">!</span>
              )}
            </div>
          </div>
          <div className="mt-1 h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${Math.min((frontDistance / 1000) * 100, 100)}%`,
                background:
                  frontDistance < 200
                    ? 'var(--accent-red)'
                    : frontDistance < 500
                    ? 'var(--accent-orange)'
                    : 'var(--accent-green)',
              }}
            />
          </div>
        </div>

        <div className="h-px bg-[var(--border-primary)]" />

        {/* Stats grid - more compact */}
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="data-label text-[8px]">Stuck</div>
            <div className="font-mono text-xs">{worldState?.stuck_counter || 0}</div>
          </div>
          <div>
            <div className="data-label text-[8px]">Queue</div>
            <div className="font-mono text-xs">{worldState?.health.queue_depth || 0}</div>
          </div>
          <div>
            <div className="data-label text-[8px]">Loc</div>
            <div className="font-mono text-xs">
              {((worldState?.confidence.localization || 0) * 100).toFixed(0)}%
            </div>
          </div>
          <div>
            <div className="data-label text-[8px]">Update</div>
            <div className="font-mono text-xs">
              {lastUpdate ? `${((Date.now() - lastUpdate) / 1000).toFixed(0)}s` : '-'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
