import type { Decision } from '../types';
import { clearDecisions } from '../api';

interface DecisionQueueProps {
  decisions: Decision[];
  onClear?: () => void;
}

export function DecisionQueue({ decisions, onClear }: DecisionQueueProps) {
  const handleClear = async () => {
    try {
      await clearDecisions();
      onClear?.();
    } catch (err) {
      console.error('Failed to clear decisions:', err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-[var(--bp-line-dim)]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[var(--bp-green)] animate-pulse" />
          <span className="font-mono text-[10px] text-[var(--bp-cream-dim)] tracking-wider">
            COPILOT ACTIVE
          </span>
        </div>
        <button
          onClick={handleClear}
          className="font-mono text-[9px] text-[var(--bp-cream-dim)] hover:text-[var(--bp-cream)] transition-colors"
        >
          CLEAR
        </button>
      </div>

      {/* Queue list */}
      <div className="flex-1 overflow-auto p-1.5 space-y-1">
        {decisions.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <span className="font-mono text-xs text-[var(--bp-cream-dim)]">
              NO DECISIONS
            </span>
          </div>
        ) : (
          decisions.map((decision, idx) => (
            <DecisionRow
              key={decision.timestamp_ms}
              decision={decision}
              isLatest={idx === 0}
            />
          ))
        )}
      </div>

      {/* Footer stats */}
      <div className="flex-shrink-0 px-2 py-1.5 border-t border-[var(--bp-line-dim)]">
        <div className="font-mono text-[9px] text-[var(--bp-cream-dim)] text-center">
          {decisions.length} / 20 decisions buffered
        </div>
      </div>
    </div>
  );
}

function DecisionRow({ decision, isLatest }: { decision: Decision; isLatest: boolean }) {
  const wasOverridden = decision.final !== decision.committed;
  const age = Date.now() - decision.timestamp_ms;
  const ageStr = age < 60000 ? `${Math.floor(age / 1000)}s` : `${Math.floor(age / 60000)}m`;

  return (
    <div
      className={`bp-decision-row p-1.5 border transition-all ${
        isLatest
          ? 'bg-[var(--bp-line)]/10 border-[var(--bp-line)]'
          : 'bg-[var(--bp-bg)] border-[var(--bp-line-dim)]'
      }`}
    >
      {/* Top row: committed action + age */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <ActionBadge action={decision.committed} />
          {wasOverridden && (
            <span className="bp-tag warning text-[8px]">OVERRIDE</span>
          )}
        </div>
        <span className="font-mono text-[9px] text-[var(--bp-cream-dim)]">{ageStr}</span>
      </div>

      {/* Trace path */}
      <div className="flex items-center gap-1 mb-1 overflow-x-auto">
        {decision.trace.map((step, idx) => (
          <span key={idx} className="flex items-center gap-1">
            {idx > 0 && (
              <svg className="w-2 h-2 text-[var(--bp-line-dim)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
            <TraceStep step={step} />
          </span>
        ))}
      </div>

      {/* Depth zones mini-bar */}
      <div className="flex gap-1">
        <DepthMini label="L" value={decision.depth.left} />
        <DepthMini label="C" value={decision.depth.center} />
        <DepthMini label="R" value={decision.depth.right} />
        {decision.corner_level > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            <span className="font-mono text-[8px] text-[var(--bp-orange)]">
              CORNER {decision.corner_level}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const colorMap: Record<string, string> = {
    FORWARD: 'var(--bp-green)',
    TURN_LEFT: 'var(--bp-line-bright)',
    TURN_RIGHT: 'var(--bp-line-bright)',
    LEFT: 'var(--bp-line-bright)',
    RIGHT: 'var(--bp-line-bright)',
    STOP: 'var(--bp-red)',
    REVERSE: 'var(--bp-orange)',
    BACKWARD: 'var(--bp-orange)',
  };

  const color = colorMap[action] || 'var(--bp-cream-dim)';
  const arrow = getActionArrow(action);

  return (
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] font-medium"
      style={{ background: color, color: 'var(--bp-bg)' }}
    >
      {arrow && <span>{arrow}</span>}
      <span>{action}</span>
    </div>
  );
}

function getActionArrow(action: string): string | null {
  switch (action) {
    case 'FORWARD': return '↑';
    case 'BACKWARD':
    case 'REVERSE': return '↓';
    case 'LEFT':
    case 'TURN_LEFT': return '←';
    case 'RIGHT':
    case 'TURN_RIGHT': return '→';
    case 'STOP': return '■';
    default: return null;
  }
}

function TraceStep({ step }: { step: string }) {
  // Parse "source:ACTION" format
  const [source, action] = step.includes(':') ? step.split(':') : ['', step];

  return (
    <span className="font-mono text-[8px] text-[var(--bp-cream-dim)] whitespace-nowrap">
      {source && <span className="text-[var(--bp-line-dim)]">{source}:</span>}
      <span>{action}</span>
    </span>
  );
}

function DepthMini({ label, value }: { label: string; value: number }) {
  // Color based on depth value (lower = closer = more red)
  const percent = Math.min(value, 100);
  const hue = (percent / 100) * 120; // 0 (red) to 120 (green)
  const color = `hsl(${hue}, 70%, 50%)`;

  return (
    <div className="flex-1 min-w-0">
      <div className="flex justify-between items-center">
        <span className="font-mono text-[7px] text-[var(--bp-cream-dim)]">{label}</span>
        <span className="font-mono text-[8px]" style={{ color }}>
          {value.toFixed(0)}
        </span>
      </div>
      <div className="h-1 bg-[var(--bp-bg-light)] mt-0.5">
        <div
          className="h-full transition-all"
          style={{ width: `${percent}%`, background: color }}
        />
      </div>
    </div>
  );
}
