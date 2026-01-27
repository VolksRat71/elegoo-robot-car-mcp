import type { DetectedObject } from '../types';

interface DetectionsPanelProps {
  detections: DetectedObject[];
  placeTags: string[];
}

export function DetectionsPanel({ detections, placeTags }: DetectionsPanelProps) {
  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>Detected Objects</span>
        {detections.length > 0 && (
          <span className="text-[var(--accent-teal)] text-[10px]">{detections.length} found</span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-3 min-h-0">
        {detections.length === 0 ? (
          <div className="text-[var(--text-muted)] text-xs text-center py-4">
            No objects detected
          </div>
        ) : (
          <div className="space-y-2">
            {detections.map((obj, idx) => (
              <DetectionItem key={idx} detection={obj} />
            ))}
          </div>
        )}
      </div>

      {/* Place Tags */}
      <div className="border-t border-[var(--border-primary)] p-3 flex-shrink-0">
        <div className="data-label text-[9px] mb-1.5">Place Classification</div>
        {placeTags.length === 0 ? (
          <div className="text-[var(--text-muted)] text-xs">Unknown area</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {placeTags.map((tag, idx) => (
              <span
                key={idx}
                className="px-1.5 py-0.5 text-[10px] font-mono bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded text-[var(--accent-teal)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DetectionItem({ detection }: { detection: DetectedObject }) {
  const confidencePercent = detection.confidence * 100;

  // Color based on confidence
  const getConfidenceColor = (conf: number) => {
    if (conf >= 0.8) return 'var(--accent-green)';
    if (conf >= 0.5) return 'var(--accent-yellow)';
    return 'var(--accent-orange)';
  };

  const color = getConfidenceColor(detection.confidence);

  return (
    <div className="bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded p-2">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: color, boxShadow: `0 0 4px ${color}` }}
          />
          <span className="font-medium text-xs text-[var(--text-primary)] capitalize">
            {detection.label}
          </span>
        </div>
        <span
          className="font-mono text-[10px] font-semibold"
          style={{ color }}
        >
          {confidencePercent.toFixed(0)}%
        </span>
      </div>

      {/* Bearing indicator with value */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-[var(--text-muted)] w-12">
          {detection.bearing_deg > 0 ? '+' : ''}{detection.bearing_deg.toFixed(0)}deg
        </span>
        <div className="flex-1 relative h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
          <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--text-muted)]/30" />
          <div
            className="absolute top-0 bottom-0 w-1.5 rounded-full"
            style={{
              left: `calc(50% + ${(detection.bearing_deg / 30) * 50}% - 3px)`,
              background: color,
            }}
          />
        </div>
      </div>
    </div>
  );
}
