import type { DepthResult, DetectedObject } from '../types';

interface VisionPanelProps {
  cameraImage?: string;
  depthImage?: string;
  annotatedImage?: string;
  depth?: DepthResult;
  detections?: DetectedObject[];
  isLoading?: boolean;
}

export function VisionPanel({
  cameraImage,
  depthImage,
  annotatedImage,
  depth,
  detections = [],
  isLoading,
}: VisionPanelProps) {
  const displayImage = annotatedImage || cameraImage;

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* Camera / Detection View */}
      <div className="panel">
        <div className="panel-header flex items-center justify-between">
          <span>Camera Feed</span>
          {detections.length > 0 && (
            <span className="text-[var(--accent-teal)] text-xs font-mono">
              {detections.length} detected
            </span>
          )}
        </div>
        <div className="relative aspect-[4/3] bg-[var(--bg-secondary)] overflow-hidden">
          {displayImage ? (
            <img
              src={`data:image/jpeg;base64,${displayImage}`}
              alt="Robot camera view"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <div className="text-[var(--text-muted)] text-sm">No image available</div>
                <div className="text-[var(--text-muted)] text-xs mt-1">
                  Waiting for camera feed...
                </div>
              </div>
            </div>
          )}
          {isLoading && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-[var(--accent-cyan)] border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {/* Scanline overlay */}
          <div className="absolute inset-0 pointer-events-none scanlines" />
          {/* Corner decorations */}
          <div className="absolute top-2 left-2 w-4 h-4 border-l-2 border-t-2 border-[var(--accent-cyan)]/50" />
          <div className="absolute top-2 right-2 w-4 h-4 border-r-2 border-t-2 border-[var(--accent-cyan)]/50" />
          <div className="absolute bottom-2 left-2 w-4 h-4 border-l-2 border-b-2 border-[var(--accent-cyan)]/50" />
          <div className="absolute bottom-2 right-2 w-4 h-4 border-r-2 border-b-2 border-[var(--accent-cyan)]/50" />
        </div>
      </div>

      {/* Depth Map View */}
      <div className="panel">
        <div className="panel-header flex items-center justify-between">
          <span>Depth Estimation</span>
          {depth && (
            <span className="text-[var(--accent-orange)] text-xs font-mono">
              center: {(depth.center_depth * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <div className="relative aspect-[4/3] bg-[var(--bg-secondary)] overflow-hidden">
          {depthImage ? (
            <img
              src={`data:image/jpeg;base64,${depthImage}`}
              alt="Depth map"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <div className="text-[var(--text-muted)] text-sm">No depth data</div>
                <div className="text-[var(--text-muted)] text-xs mt-1">
                  Vision service may be loading...
                </div>
              </div>
            </div>
          )}
          {/* Depth zone indicators */}
          {depth && !depthImage && (
            <div className="absolute inset-0 flex">
              <DepthZone value={depth.depth_zones.left} label="L" />
              <DepthZone value={depth.depth_zones.center} label="C" />
              <DepthZone value={depth.depth_zones.right} label="R" />
            </div>
          )}
          {/* Corner decorations */}
          <div className="absolute top-2 left-2 w-4 h-4 border-l-2 border-t-2 border-[var(--accent-orange)]/50" />
          <div className="absolute top-2 right-2 w-4 h-4 border-r-2 border-t-2 border-[var(--accent-orange)]/50" />
          <div className="absolute bottom-2 left-2 w-4 h-4 border-l-2 border-b-2 border-[var(--accent-orange)]/50" />
          <div className="absolute bottom-2 right-2 w-4 h-4 border-r-2 border-b-2 border-[var(--accent-orange)]/50" />
        </div>
        {/* Depth zone bar */}
        {depth && (
          <div className="p-3 border-t border-[var(--border-primary)]">
            <div className="flex gap-2">
              <DepthBar label="LEFT" value={depth.depth_zones.left} />
              <DepthBar label="CENTER" value={depth.depth_zones.center} />
              <DepthBar label="RIGHT" value={depth.depth_zones.right} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DepthZone({ value, label }: { value: number; label: string }) {
  // Higher value = closer = more red/orange, lower = farther = more blue/green
  const hue = (1 - value) * 180; // 0 (red) to 180 (cyan)
  return (
    <div
      className="flex-1 flex items-center justify-center relative"
      style={{
        background: `linear-gradient(180deg, hsla(${hue}, 80%, 40%, 0.8), hsla(${hue}, 80%, 20%, 0.6))`,
      }}
    >
      <div className="text-center">
        <div className="text-white/80 text-xs font-mono">{label}</div>
        <div className="text-white text-lg font-mono font-bold">{(value * 100).toFixed(0)}%</div>
      </div>
    </div>
  );
}

function DepthBar({ label, value }: { label: string; value: number }) {
  const hue = (1 - value) * 180;
  return (
    <div className="flex-1">
      <div className="flex justify-between mb-1">
        <span className="data-label">{label}</span>
        <span className="font-mono text-xs text-[var(--text-secondary)]">
          {(value * 100).toFixed(0)}%
        </span>
      </div>
      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{
            width: `${value * 100}%`,
            background: `hsl(${hue}, 70%, 50%)`,
          }}
        />
      </div>
    </div>
  );
}
