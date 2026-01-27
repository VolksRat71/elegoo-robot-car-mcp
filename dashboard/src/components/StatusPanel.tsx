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
      <div className="p-4 space-y-4">
        {/* Connection status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`status-dot ${robotConnected ? 'active' : 'error'}`} />
            <span className="text-sm">Robot Connection</span>
          </div>
          <span className={`text-xs font-mono ${robotConnected ? 'text-[var(--accent-green)]' : 'text-[var(--accent-red)]'}`}>
            {robotConnected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`status-dot ${visionAvailable ? 'active' : 'warning'}`} />
            <span className="text-sm">Vision Service</span>
          </div>
          <span className={`text-xs font-mono ${visionAvailable ? 'text-[var(--accent-green)]' : 'text-[var(--accent-orange)]'}`}>
            {visionAvailable ? 'READY' : 'LOADING'}
          </span>
        </div>

        <div className="h-px bg-[var(--border-primary)]" />

        {/* Autonomy state */}
        <div>
          <div className="data-label mb-2">Autonomy State</div>
          <div
            className="font-mono text-lg font-bold"
            style={{ color: getStateColor(state) }}
          >
            {state}
          </div>
          {worldState?.last_action && (
            <div className="text-xs text-[var(--text-muted)] mt-1">
              Last: {worldState.last_action}
            </div>
          )}
        </div>

        {/* Safety level */}
        <div>
          <div className="flex justify-between mb-2">
            <span className="data-label">Safety Level</span>
            <span
              className="font-mono text-sm font-semibold"
              style={{ color: getSafetyColor(safetyPercent) }}
            >
              {safetyPercent.toFixed(0)}%
            </span>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: `${safetyPercent}%`,
                background: getSafetyColor(safetyPercent),
              }}
            />
          </div>
        </div>

        {/* Front distance */}
        <div>
          <div className="data-label mb-1">Front Distance</div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-[var(--text-primary)]">
              {formatDistance(frontDistance)}
            </span>
            {frontDistance < 200 && frontDistance > 0 && (
              <span className="text-xs text-[var(--accent-orange)]">CLOSE</span>
            )}
          </div>
          {/* Distance bar visualization */}
          <div className="mt-2 h-2 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
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
          <div className="flex justify-between text-[10px] text-[var(--text-muted)] mt-1 font-mono">
            <span>0</span>
            <span>1m</span>
          </div>
        </div>

        <div className="h-px bg-[var(--border-primary)]" />

        {/* Additional stats */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="data-label">Stuck Counter</div>
            <div className="data-value">{worldState?.stuck_counter || 0}</div>
          </div>
          <div>
            <div className="data-label">Queue Depth</div>
            <div className="data-value">{worldState?.health.queue_depth || 0}</div>
          </div>
          <div>
            <div className="data-label">Localization</div>
            <div className="data-value">
              {((worldState?.confidence.localization || 0) * 100).toFixed(0)}%
            </div>
          </div>
          <div>
            <div className="data-label">Last Update</div>
            <div className="data-value text-xs">
              {lastUpdate ? `${((Date.now() - lastUpdate) / 1000).toFixed(1)}s ago` : '-'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
