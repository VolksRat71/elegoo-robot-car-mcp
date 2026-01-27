import { useState } from 'react';
import type { DepthResult, DetectedObject } from '../types';

interface CameraFeedProps {
  cameraImage?: string;
  depthImage?: string;
  annotatedImage?: string;
  depth?: DepthResult;
  detections?: DetectedObject[];
  isLoading?: boolean;
}

type ViewMode = 'camera' | 'depth' | 'split';

export function CameraFeed({
  cameraImage,
  depthImage,
  annotatedImage,
  depth,
  detections = [],
  isLoading,
}: CameraFeedProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('camera');
  const displayImage = annotatedImage || cameraImage;

  return (
    <div className="bp-frame h-full flex flex-col">
      <span className="bp-label">PRIMARY FEED</span>
      <div className="bp-frame-inner flex flex-col h-full">
        {/* View mode tabs */}
        <div className="flex items-center gap-1 p-2 border-b border-[var(--bp-line-dim)]">
          <ViewTab active={viewMode === 'camera'} onClick={() => setViewMode('camera')}>
            CAMERA
          </ViewTab>
          <ViewTab active={viewMode === 'depth'} onClick={() => setViewMode('depth')}>
            DEPTH
          </ViewTab>
          <ViewTab active={viewMode === 'split'} onClick={() => setViewMode('split')}>
            SPLIT
          </ViewTab>
          <div className="flex-1" />
          {detections.length > 0 && (
            <span className="bp-tag success">
              {detections.length} DETECTED
            </span>
          )}
        </div>

        {/* Feed content */}
        <div className="flex-1 min-h-0 p-2">
          {viewMode === 'split' ? (
            <div className="h-full grid grid-cols-2 gap-2">
              <FeedPanel
                image={displayImage}
                label="RGB"
                isLoading={isLoading}
                hasDetections={detections.length > 0}
              />
              <FeedPanel
                image={depthImage}
                label="DEPTH"
                depth={depth}
                accentColor="var(--bp-orange)"
              />
            </div>
          ) : viewMode === 'depth' ? (
            <FeedPanel
              image={depthImage}
              label="DEPTH MAP"
              depth={depth}
              accentColor="var(--bp-orange)"
              fullSize
            />
          ) : (
            <FeedPanel
              image={displayImage}
              label="CAMERA"
              isLoading={isLoading}
              hasDetections={detections.length > 0}
              fullSize
            />
          )}
        </div>

        {/* Depth zones bar - always visible when depth data exists */}
        {depth && (
          <div className="flex-shrink-0 border-t border-[var(--bp-line-dim)] p-2">
            <DepthZonesBar depth={depth} />
          </div>
        )}
      </div>
    </div>
  );
}

function ViewTab({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-[10px] font-mono tracking-wider transition-all ${
        active
          ? 'bg-[var(--bp-line)] text-[var(--bp-bg)] font-medium'
          : 'text-[var(--bp-cream-dim)] hover:text-[var(--bp-cream)]'
      }`}
    >
      {children}
    </button>
  );
}

function FeedPanel({
  image,
  label,
  depth,
  isLoading,
  hasDetections,
  accentColor = 'var(--bp-line)',
  fullSize,
}: {
  image?: string;
  label: string;
  depth?: DepthResult;
  isLoading?: boolean;
  hasDetections?: boolean;
  accentColor?: string;
  fullSize?: boolean;
}) {
  return (
    <div
      className={`relative bg-[var(--bp-bg)] border border-[var(--bp-line-dim)] overflow-hidden ${
        fullSize ? 'h-full' : 'aspect-[4/3]'
      }`}
    >
      {/* Corner marks */}
      <CornerMarks color={accentColor} />

      {/* Crosshair */}
      <div className="bp-crosshair" style={{ '--bp-line': accentColor } as React.CSSProperties} />

      {/* Image or placeholder */}
      {image ? (
        <img
          src={`data:image/jpeg;base64,${image}`}
          alt={label}
          className="w-full h-full object-contain"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            {isLoading ? (
              <div className="bp-spinner mx-auto" />
            ) : (
              <>
                <div className="bp-hatch absolute inset-0" />
                <span className="relative font-mono text-xs text-[var(--bp-cream-dim)]">
                  NO SIGNAL
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Scanlines overlay */}
      <div className="bp-scanlines absolute inset-0 pointer-events-none" />

      {/* Label */}
      <div
        className="absolute top-2 left-2 px-2 py-0.5 text-[9px] font-mono tracking-wider"
        style={{ background: accentColor, color: 'var(--bp-bg)' }}
      >
        {label}
      </div>

      {/* Detection count badge */}
      {hasDetections && (
        <div className="absolute top-2 right-2 px-2 py-0.5 text-[9px] font-mono bg-[var(--bp-green)] text-[var(--bp-bg)]">
          TRACKING
        </div>
      )}

      {/* Depth reading overlay */}
      {depth && (
        <div className="absolute bottom-2 right-2 font-mono text-sm" style={{ color: accentColor }}>
          <span className="text-[var(--bp-cream-dim)] text-xs">CENTER </span>
          {(depth.center_depth * 100).toFixed(0)}%
        </div>
      )}
    </div>
  );
}

function CornerMarks({ color }: { color: string }) {
  const style = { borderColor: color };
  return (
    <>
      <div className="absolute top-1 left-1 w-4 h-4 border-l-2 border-t-2" style={style} />
      <div className="absolute top-1 right-1 w-4 h-4 border-r-2 border-t-2" style={style} />
      <div className="absolute bottom-1 left-1 w-4 h-4 border-l-2 border-b-2" style={style} />
      <div className="absolute bottom-1 right-1 w-4 h-4 border-r-2 border-b-2" style={style} />
    </>
  );
}

function DepthZonesBar({ depth }: { depth: DepthResult }) {
  const zones = [
    { key: 'left', label: 'L', value: depth.depth_zones.left },
    { key: 'center', label: 'C', value: depth.depth_zones.center },
    { key: 'right', label: 'R', value: depth.depth_zones.right },
  ];

  return (
    <div className="flex gap-2">
      {zones.map(({ key, label, value }) => {
        // Color based on proximity: green (far) -> yellow -> orange -> red (close)
        const hue = (1 - value) * 120; // 120 (green) to 0 (red)
        const color = `hsl(${hue}, 70%, 50%)`;

        return (
          <div key={key} className="flex-1">
            <div className="flex justify-between items-center mb-1">
              <span className="font-mono text-[9px] text-[var(--bp-cream-dim)]">{label}</span>
              <span className="font-mono text-xs" style={{ color }}>
                {(value * 100).toFixed(0)}%
              </span>
            </div>
            <div className="bp-progress">
              <div
                className="bp-progress-fill"
                style={{ width: `${value * 100}%`, background: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
