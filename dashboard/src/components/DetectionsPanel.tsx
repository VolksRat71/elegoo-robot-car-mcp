import type { DetectedObject } from '../types';

interface DetectionsPanelProps {
  detections: DetectedObject[];
  placeTags: string[];
}

export function DetectionsPanel({ detections, placeTags }: DetectionsPanelProps) {
  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">Detected Objects</div>
      <div className="flex-1 overflow-auto p-4">
        {detections.length === 0 ? (
          <div className="text-[var(--text-muted)] text-sm text-center py-8">
            No objects detected
          </div>
        ) : (
          <div className="space-y-3">
            {detections.map((obj, idx) => (
              <DetectionItem key={idx} detection={obj} />
            ))}
          </div>
        )}
      </div>

      {/* Place Tags */}
      <div className="border-t border-[var(--border-primary)] p-4">
        <div className="data-label mb-2">Place Classification</div>
        {placeTags.length === 0 ? (
          <div className="text-[var(--text-muted)] text-sm">Unknown area</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {placeTags.map((tag, idx) => (
              <span
                key={idx}
                className="px-2 py-1 text-xs font-mono bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded text-[var(--accent-teal)]"
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
    <div className="bg-[var(--bg-tertiary)] border border-[var(--border-primary)] rounded-lg p-3">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: color, boxShadow: `0 0 6px ${color}` }}
          />
          <span className="font-medium text-[var(--text-primary)] capitalize">
            {detection.label}
          </span>
        </div>
        <span
          className="font-mono text-sm font-semibold"
          style={{ color }}
        >
          {confidencePercent.toFixed(0)}%
        </span>
      </div>

      {/* Confidence bar */}
      <div className="progress-bar mb-2">
        <div
          className="progress-fill"
          style={{ width: `${confidencePercent}%`, background: color }}
        />
      </div>

      {/* Bearing */}
      <div className="flex items-center gap-4 text-xs">
        <div>
          <span className="text-[var(--text-muted)]">Bearing: </span>
          <span className="font-mono text-[var(--text-secondary)]">
            {detection.bearing_deg > 0 ? '+' : ''}{detection.bearing_deg.toFixed(1)}deg
          </span>
        </div>
        {detection.bbox && (
          <div>
            <span className="text-[var(--text-muted)]">Size: </span>
            <span className="font-mono text-[var(--text-secondary)]">
              {Math.round(detection.bbox.x2 - detection.bbox.x1)}x
              {Math.round(detection.bbox.y2 - detection.bbox.y1)}
            </span>
          </div>
        )}
      </div>

      {/* Bearing indicator */}
      <div className="mt-2 relative h-2 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--text-muted)]" />
        <div
          className="absolute top-0 bottom-0 w-2 rounded-full"
          style={{
            left: `calc(50% + ${(detection.bearing_deg / 30) * 50}% - 4px)`,
            background: color,
            boxShadow: `0 0 4px ${color}`,
          }}
        />
      </div>
    </div>
  );
}
