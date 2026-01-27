import type { WorldState, DetectedObject } from '../types';

interface TelemetryProps {
  worldState?: WorldState;
  lastUpdate?: number;
  detections: DetectedObject[];
}

export function Telemetry({
  worldState,
  lastUpdate,
  detections,
}: TelemetryProps) {
  const state = worldState?.autonomy_state || 'OFFLINE';
  const safetyPercent = (worldState?.confidence.safety || 0) * 100;
  const frontDistance = worldState?.geometry.front_min_mm || 0;

  return (
    <div className="bp-frame flex-1 flex flex-col min-h-0">
      <span className="bp-label">TELEMETRY</span>
      <div className="bp-frame-inner flex flex-col h-full">
        {/* Primary stats */}
        <div className="p-3 border-b border-[var(--bp-line-dim)]">
          {/* State + Safety row */}
          <div className="flex gap-4 mb-3">
            <div className="flex-1">
              <div className="bp-readout-label">STATE</div>
              <div
                className="font-mono text-base font-medium"
                style={{ color: getStateColor(state) }}
              >
                {state}
              </div>
            </div>
            <div className="flex-1">
              <div className="flex justify-between">
                <span className="bp-readout-label">SAFETY</span>
                <span
                  className="font-mono text-xs"
                  style={{ color: getSafetyColor(safetyPercent) }}
                >
                  {safetyPercent.toFixed(0)}%
                </span>
              </div>
              <div className="bp-progress mt-1">
                <div
                  className="bp-progress-fill"
                  style={{
                    width: `${safetyPercent}%`,
                    background: getSafetyColor(safetyPercent),
                  }}
                />
              </div>
            </div>
          </div>

          {/* Front distance */}
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="bp-readout-label">FRONT DISTANCE</span>
              {frontDistance < 200 && frontDistance > 0 && (
                <span className="bp-tag warning text-[8px]">CLOSE</span>
              )}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="bp-readout-value" style={{ color: getDistanceColor(frontDistance) }}>
                {formatDistance(frontDistance)}
              </span>
            </div>
            <div className="bp-progress mt-1">
              <div
                className="bp-progress-fill"
                style={{
                  width: `${Math.min((frontDistance / 1000) * 100, 100)}%`,
                  background: getDistanceColor(frontDistance),
                }}
              />
            </div>
          </div>
        </div>

        {/* Secondary stats grid */}
        <div className="grid grid-cols-4 gap-2 p-3 border-b border-[var(--bp-line-dim)] text-center">
          <MiniStat label="STUCK" value={worldState?.stuck_counter || 0} />
          <MiniStat label="QUEUE" value={worldState?.health.queue_depth || 0} />
          <MiniStat
            label="LOC"
            value={`${((worldState?.confidence.localization || 0) * 100).toFixed(0)}%`}
          />
          <MiniStat
            label="AGO"
            value={lastUpdate ? `${((Date.now() - lastUpdate) / 1000).toFixed(0)}s` : '—'}
          />
        </div>

        {/* Detections list */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 border-b border-[var(--bp-line-dim)] flex items-center justify-between">
            <span className="bp-readout-label">DETECTED OBJECTS</span>
            {detections.length > 0 && (
              <span className="bp-tag success">{detections.length}</span>
            )}
          </div>
          <div className="flex-1 overflow-auto p-2">
            {detections.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <span className="font-mono text-xs text-[var(--bp-cream-dim)]">
                  NO OBJECTS
                </span>
              </div>
            ) : (
              <div className="space-y-1">
                {detections.map((obj, idx) => (
                  <DetectionRow key={idx} detection={obj} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Place tags */}
        {worldState?.semantics?.current_place_tags && worldState.semantics.current_place_tags.length > 0 && (
          <div className="flex-shrink-0 p-2 border-t border-[var(--bp-line-dim)]">
            <div className="flex flex-wrap gap-1">
              {worldState.semantics.current_place_tags.map((tag, idx) => (
                <span key={idx} className="bp-tag">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="font-mono text-[8px] text-[var(--bp-cream-dim)] tracking-wider">{label}</div>
      <div className="font-mono text-sm text-[var(--bp-cream)]">{value}</div>
    </div>
  );
}

function DetectionRow({ detection }: { detection: DetectedObject }) {
  const confidence = detection.confidence * 100;
  const color = getConfidenceColor(detection.confidence);

  return (
    <div className="bp-detection-row flex items-center gap-2 p-1.5 bg-[var(--bp-bg)] border border-[var(--bp-line-dim)]">
      {/* Confidence dot */}
      <div
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      />

      {/* Label */}
      <span className="font-mono text-xs text-[var(--bp-cream)] flex-1 truncate capitalize">
        {detection.label}
      </span>

      {/* Bearing indicator */}
      <div className="flex items-center gap-1">
        <span className="font-mono text-[9px] text-[var(--bp-cream-dim)]">
          {detection.bearing_deg > 0 ? '+' : ''}
          {detection.bearing_deg.toFixed(0)}°
        </span>
        <BearingIndicator bearing={detection.bearing_deg} color={color} />
      </div>

      {/* Confidence */}
      <span className="font-mono text-[10px] w-8 text-right" style={{ color }}>
        {confidence.toFixed(0)}%
      </span>
    </div>
  );
}

function BearingIndicator({ bearing, color }: { bearing: number; color: string }) {
  // Clamp bearing to -30 to +30 for display
  const clampedBearing = Math.max(-30, Math.min(30, bearing));
  const position = ((clampedBearing + 30) / 60) * 100;

  return (
    <div className="w-8 h-2 bg-[var(--bp-bg-light)] border border-[var(--bp-line-dim)] relative">
      {/* Center line */}
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--bp-line-dim)]" />
      {/* Position marker */}
      <div
        className="absolute top-0 bottom-0 w-1"
        style={{
          left: `${position}%`,
          transform: 'translateX(-50%)',
          background: color,
        }}
      />
    </div>
  );
}

function getStateColor(state: string) {
  switch (state) {
    case 'IDLE':
      return 'var(--bp-line-bright)';
    case 'EXECUTING':
      return 'var(--bp-green)';
    case 'AVOIDING':
    case 'RECOVERING':
      return 'var(--bp-orange)';
    case 'STUCK':
      return 'var(--bp-red)';
    default:
      return 'var(--bp-cream-dim)';
  }
}

function getSafetyColor(percent: number) {
  if (percent >= 70) return 'var(--bp-green)';
  if (percent >= 40) return 'var(--bp-yellow)';
  return 'var(--bp-red)';
}

function getDistanceColor(mm: number) {
  if (mm < 200) return 'var(--bp-red)';
  if (mm < 500) return 'var(--bp-orange)';
  return 'var(--bp-green)';
}

function getConfidenceColor(conf: number) {
  if (conf >= 0.8) return 'var(--bp-green)';
  if (conf >= 0.5) return 'var(--bp-yellow)';
  return 'var(--bp-orange)';
}

function formatDistance(mm: number) {
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)}m`;
  return `${mm}mm`;
}
