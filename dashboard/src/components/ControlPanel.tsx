import { useCallback, useEffect, useState } from 'react';
import { drive, stop, explore, turn } from '../api';

interface ControlPanelProps {
  onCommandStart?: () => void;
  onCommandEnd?: () => void;
  disabled?: boolean;
}

export function ControlPanel({ onCommandStart, onCommandEnd, disabled }: ControlPanelProps) {
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
    <div className="panel">
      <div className="panel-header">Robot Controls</div>
      <div className="p-4">
        {/* Direction pad */}
        <div className="flex flex-col items-center gap-2 mb-4">
          <ControlButton
            onClick={() => executeCommand(() => drive('forward', 50, 300))}
            active={activeKey === 'w' || activeKey === 'arrowup'}
            disabled={disabled}
          >
            <ArrowIcon direction="up" />
          </ControlButton>
          <div className="flex gap-2">
            <ControlButton
              onClick={() => executeCommand(() => turn(-30, 40))}
              active={activeKey === 'a' || activeKey === 'arrowleft'}
              disabled={disabled}
            >
              <ArrowIcon direction="left" />
            </ControlButton>
            <ControlButton
              onClick={handleStop}
              active={activeKey === ' '}
              disabled={disabled}
              variant="danger"
              className="w-14 h-14"
            >
              <span className="text-xs font-bold">STOP</span>
            </ControlButton>
            <ControlButton
              onClick={() => executeCommand(() => turn(30, 40))}
              active={activeKey === 'd' || activeKey === 'arrowright'}
              disabled={disabled}
            >
              <ArrowIcon direction="right" />
            </ControlButton>
          </div>
          <ControlButton
            onClick={() => executeCommand(() => drive('backward', 50, 300))}
            active={activeKey === 's' || activeKey === 'arrowdown'}
            disabled={disabled}
          >
            <ArrowIcon direction="down" />
          </ControlButton>
        </div>

        {/* Explore button */}
        <button
          onClick={handleExplore}
          disabled={disabled || isExploring}
          className={`w-full py-3 rounded-lg font-semibold text-sm transition-all ${
            isExploring
              ? 'bg-[var(--accent-cyan)]/20 border-[var(--accent-cyan)] text-[var(--accent-cyan)] animate-pulse'
              : 'control-btn primary'
          } border`}
        >
          {isExploring ? 'Exploring...' : 'Autonomous Explore (15s)'}
        </button>

        {/* Keyboard hints */}
        <div className="mt-4 pt-4 border-t border-[var(--border-primary)]">
          <div className="data-label mb-2">Keyboard Controls</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Forward</span>
              <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1.5 rounded">W</kbd>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Back</span>
              <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1.5 rounded">S</kbd>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Turn Left</span>
              <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1.5 rounded">A</kbd>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">Turn Right</span>
              <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1.5 rounded">D</kbd>
            </div>
            <div className="flex justify-between col-span-2">
              <span className="text-[var(--text-muted)]">Emergency Stop</span>
              <kbd className="font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] px-1.5 rounded">Space</kbd>
            </div>
          </div>
        </div>
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
  className?: string;
}

function ControlButton({
  children,
  onClick,
  active,
  disabled,
  variant = 'default',
  className = '',
}: ControlButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        w-12 h-12 rounded-lg flex items-center justify-center
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
