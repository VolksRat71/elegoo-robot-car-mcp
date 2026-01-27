import { useCallback, useEffect, useState } from 'react';
import { drive, stop, explore, turn } from '../api';

interface ControlPanelProps {
  onCommandStart?: () => void;
  onCommandEnd?: () => void;
  disabled?: boolean;
  compact?: boolean;
}

export function ControlPanel({ onCommandStart, onCommandEnd, disabled, compact }: ControlPanelProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isExploring, setIsExploring] = useState(false);

  const executeCommand = useCallback(
    async (cmd: () => Promise<unknown>) => {
      onCommandStart?.();
      try {
        await cmd();
      } catch (err) {
        console.error('Command failed:', err);
      } finally {
        onCommandEnd?.();
      }
    },
    [onCommandStart, onCommandEnd]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled || e.repeat) return;

      const key = e.key.toLowerCase();
      setActiveKey(key);

      switch (key) {
        case 'w':
        case 'arrowup':
          executeCommand(() => drive('forward', 50, 300));
          break;
        case 's':
        case 'arrowdown':
          executeCommand(() => drive('backward', 50, 300));
          break;
        case 'a':
        case 'arrowleft':
          executeCommand(() => turn(-30, 40));
          break;
        case 'd':
        case 'arrowright':
          executeCommand(() => turn(30, 40));
          break;
        case ' ':
          e.preventDefault();
          executeCommand(() => stop());
          break;
      }
    },
    [disabled, executeCommand]
  );

  const handleKeyUp = useCallback(() => {
    setActiveKey(null);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  const handleExplore = async () => {
    setIsExploring(true);
    onCommandStart?.();
    try {
      await explore(15);
    } catch (err) {
      console.error('Explore failed:', err);
    } finally {
      setIsExploring(false);
      onCommandEnd?.();
    }
  };

  const handleStop = async () => {
    setIsExploring(false);
    await executeCommand(() => stop());
  };

  return (
    <div className={compact ? '' : 'panel'}>
      {!compact && <div className="panel-header">Robot Controls</div>}
      <div className={compact ? 'p-3' : 'p-4'}>
        {/* Direction pad */}
        <div className="flex flex-col items-center gap-1.5 mb-3">
          <ControlButton
            onClick={() => executeCommand(() => drive('forward', 50, 300))}
            active={activeKey === 'w' || activeKey === 'arrowup'}
            disabled={disabled}
            size={compact ? 'sm' : 'md'}
          >
            <ArrowIcon direction="up" />
          </ControlButton>
          <div className="flex gap-1.5">
            <ControlButton
              onClick={() => executeCommand(() => turn(-30, 40))}
              active={activeKey === 'a' || activeKey === 'arrowleft'}
              disabled={disabled}
              size={compact ? 'sm' : 'md'}
            >
              <ArrowIcon direction="left" />
            </ControlButton>
            <ControlButton
              onClick={handleStop}
              active={activeKey === ' '}
              disabled={disabled}
              variant="danger"
              size={compact ? 'sm' : 'md'}
              className={compact ? 'w-10 h-10' : 'w-14 h-14'}
            >
              <span className="text-[10px] font-bold">STOP</span>
            </ControlButton>
            <ControlButton
              onClick={() => executeCommand(() => turn(30, 40))}
              active={activeKey === 'd' || activeKey === 'arrowright'}
              disabled={disabled}
              size={compact ? 'sm' : 'md'}
            >
              <ArrowIcon direction="right" />
            </ControlButton>
          </div>
          <ControlButton
            onClick={() => executeCommand(() => drive('backward', 50, 300))}
            active={activeKey === 's' || activeKey === 'arrowdown'}
            disabled={disabled}
            size={compact ? 'sm' : 'md'}
          >
            <ArrowIcon direction="down" />
          </ControlButton>
        </div>

        {/* Explore button */}
        <button
          onClick={handleExplore}
          disabled={disabled || isExploring}
          className={`w-full py-2 rounded-lg font-semibold text-xs transition-all ${
            isExploring
              ? 'bg-[var(--accent-cyan)]/20 border-[var(--accent-cyan)] text-[var(--accent-cyan)] animate-pulse'
              : 'control-btn primary'
          } border`}
        >
          {isExploring ? 'Exploring...' : compact ? 'Explore' : 'Autonomous Explore (15s)'}
        </button>

        {/* Keyboard hints - hide in compact mode */}
        {!compact && (
          <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
            <div className="data-label mb-1.5 text-[9px]">Keyboard</div>
            <div className="grid grid-cols-3 gap-1 text-[10px]">
              <div className="text-center">
                <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1 rounded text-[9px]">W</kbd>
              </div>
              <div className="text-center">
                <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1 rounded text-[9px]">A S D</kbd>
              </div>
              <div className="text-center">
                <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1 rounded text-[9px]">Space</kbd>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface ControlButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  variant?: 'default' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

function ControlButton({
  children,
  onClick,
  active,
  disabled,
  variant = 'default',
  size = 'md',
  className = '',
}: ControlButtonProps) {
  const sizeClasses = size === 'sm' ? 'w-10 h-10' : 'w-12 h-12';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        ${sizeClasses} rounded-lg flex items-center justify-center
        control-btn ${variant === 'danger' ? 'danger' : ''}
        ${active ? 'bg-[var(--accent-cyan)]/20 border-[var(--accent-cyan)] text-[var(--accent-cyan)]' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}
      `}
    >
      {children}
    </button>
  );
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' | 'left' | 'right' }) {
  const rotations = {
    up: 'rotate-0',
    right: 'rotate-90',
    down: 'rotate-180',
    left: '-rotate-90',
  };

  return (
    <svg
      className={`w-5 h-5 ${rotations[direction]}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}
