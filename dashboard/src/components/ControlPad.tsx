import { useCallback, useEffect, useState } from 'react';
import { drive, stop, explore, turn } from '../api';
import { DecisionQueue } from './DecisionQueue';
import type { Decision } from '../types';

interface ControlPadProps {
  onCommandStart?: () => void;
  onCommandEnd?: () => void;
  disabled?: boolean;
  copilotActive?: boolean;
  decisions?: Decision[];
  onDecisionsClear?: () => void;
}

export function ControlPad({
  onCommandStart,
  onCommandEnd,
  disabled,
  copilotActive = false,
  decisions = [],
  onDecisionsClear,
}: ControlPadProps) {
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
      // Emergency stop always works
      if (e.key === ' ' || e.key === 'Escape') {
        e.preventDefault();
        executeCommand(() => stop());
        return;
      }

      // Manual controls only when not in copilot mode
      if (disabled || copilotActive || e.repeat) return;

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
      }
    },
    [disabled, copilotActive, executeCommand]
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
    <div className="bp-frame flex flex-col" style={{ minHeight: copilotActive ? '280px' : 'auto' }}>
      <span className="bp-label">{copilotActive ? 'COPILOT' : 'CONTROLS'}</span>
      <div className="bp-frame-inner flex flex-col h-full p-3">
        {/* EMERGENCY STOP - Always visible */}
        <button
          onClick={handleStop}
          disabled={disabled}
          className="bp-btn bp-emergency w-full py-3 mb-3 rounded-sm disabled:opacity-50 flex-shrink-0"
        >
          <div className="flex items-center justify-center gap-2">
            <StopIcon />
            <span>EMERGENCY STOP</span>
          </div>
          <div className="text-[10px] font-normal opacity-70 mt-0.5">
            SPACE / ESC
          </div>
        </button>

        {/* Conditional content: Manual controls OR Decision queue */}
        {copilotActive ? (
          <div className="flex-1 min-h-0 border border-[var(--bp-line-dim)] bg-[var(--bp-bg)]">
            <DecisionQueue decisions={decisions} onClear={onDecisionsClear} />
          </div>
        ) : (
          <>
            {/* Direction Pad */}
            <div className="flex flex-col items-center gap-1 mb-3">
              <DirectionButton
                direction="up"
                onClick={() => executeCommand(() => drive('forward', 50, 300))}
                active={activeKey === 'w' || activeKey === 'arrowup'}
                disabled={disabled}
                hint="W"
              />
              <div className="flex gap-1">
                <DirectionButton
                  direction="left"
                  onClick={() => executeCommand(() => turn(-30, 40))}
                  active={activeKey === 'a' || activeKey === 'arrowleft'}
                  disabled={disabled}
                  hint="A"
                />
                <div className="w-14 h-14 flex items-center justify-center border-2 border-[var(--bp-line-dim)] bg-[var(--bp-bg)]">
                  <div className="w-3 h-3 rounded-full border-2 border-[var(--bp-line-dim)]" />
                </div>
                <DirectionButton
                  direction="right"
                  onClick={() => executeCommand(() => turn(30, 40))}
                  active={activeKey === 'd' || activeKey === 'arrowright'}
                  disabled={disabled}
                  hint="D"
                />
              </div>
              <DirectionButton
                direction="down"
                onClick={() => executeCommand(() => drive('backward', 50, 300))}
                active={activeKey === 's' || activeKey === 'arrowdown'}
                disabled={disabled}
                hint="S"
              />
            </div>

            {/* Explore button */}
            <button
              onClick={handleExplore}
              disabled={disabled || isExploring}
              className={`bp-btn w-full py-2 text-xs font-mono tracking-wider ${
                isExploring ? 'active' : ''
              }`}
            >
              {isExploring ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="bp-spinner" style={{ width: 14, height: 14, borderWidth: 1 }} />
                  EXPLORING...
                </span>
              ) : (
                'AUTO EXPLORE'
              )}
            </button>

            {/* Keyboard hint */}
            <div className="mt-3 pt-3 border-t border-[var(--bp-line-dim)]">
              <div className="font-mono text-[9px] text-[var(--bp-cream-dim)] text-center">
                WASD / ARROWS to move
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DirectionButton({
  direction,
  onClick,
  active,
  disabled,
  hint,
}: {
  direction: 'up' | 'down' | 'left' | 'right';
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  hint: string;
}) {
  const rotations = {
    up: '',
    right: 'rotate-90',
    down: 'rotate-180',
    left: '-rotate-90',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-14 h-14 flex flex-col items-center justify-center gap-0.5 border-2 transition-all ${
        active
          ? 'bg-[var(--bp-line)]/20 border-[var(--bp-line-bright)] text-[var(--bp-line-bright)] shadow-[0_0_12px_var(--bp-line)]'
          : 'bg-[var(--bp-bg-light)] border-[var(--bp-line-dim)] text-[var(--bp-cream)] hover:border-[var(--bp-line)] hover:text-[var(--bp-line-bright)]'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <svg
        className={`w-5 h-5 ${rotations[direction]}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={2.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
      <span className="text-[9px] font-mono opacity-60">{hint}</span>
    </button>
  );
}

function StopIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}
