import { useState } from 'react';
import { Play, Square, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';

const LISTS = [
  { value: '1st', label: '1st Attempt' },
  { value: '2nd', label: '2nd Attempt' },
  { value: '3rd', label: '3rd Attempt' },
];

const ALL_MODES = [
  { value: 'dry',  label: 'Dry Run' },
  { value: 'live', label: 'Live', danger: true },
];

// Non-admin production builds only expose Live mode
const PROD_MODES = [
  { value: 'live', label: 'Live', danger: true },
];

const MAX_OPTIONS = [
  { value: '1', label: '1' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: 'all', label: 'All' },
];

const DELAY_OPTIONS = [
  { value: 'safe', label: 'Safe' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
  { value: 'turbo', label: 'Turbo' },
];

function SegmentedControl({ options, value, onChange, disabled }) {
  return (
    <div
      className="flex rounded-lg p-1 gap-1"
      style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => !disabled && onChange(opt.value)}
          disabled={disabled}
          className={`
            flex-1 py-1.5 px-2 rounded-md text-xs font-medium transition-all duration-150 whitespace-nowrap
            ${value === opt.value
              ? opt.danger
                ? 'bg-red-600 text-white shadow-sm'
                : 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
            }
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          `}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <label className="block text-xs font-medium mb-2" style={{ color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
      {children}
    </label>
  );
}

export default function ControlCard({ config, setConfig, runState, onStart, onStop, isAdmin }) {
  const isRunning = runState === 'running';
  const isIdle    = runState === 'idle';
  const MODES     = isAdmin ? ALL_MODES : PROD_MODES;
  const showLiveWarning = config.mode === 'live';

  const set = (key) => (value) => setConfig((prev) => ({ ...prev, [key]: value }));

  return (
    <div
      className="rounded-xl p-5 flex flex-col gap-5"
      style={{ background: '#13131a', border: '1px solid #1e1e2e' }}
    >
      <div>
        <h2 className="text-sm font-semibold" style={{ color: '#f1f5f9' }}>Run Configuration</h2>
        <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>Set parameters and launch the bot</p>
      </div>

      {/* List selector */}
      <div>
        <FieldLabel>Attempt List</FieldLabel>
        <SegmentedControl
          options={LISTS}
          value={config.list}
          onChange={set('list')}
          disabled={isRunning}
        />
      </div>

      {/* Mode selector */}
      <div>
        <FieldLabel>Mode</FieldLabel>
        <SegmentedControl
          options={MODES}
          value={config.mode}
          onChange={set('mode')}
          disabled={isRunning}
        />
        {showLiveWarning && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 mt-2 px-3 py-2 rounded-lg"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}
          >
            <AlertTriangle size={13} className="text-red-400 flex-shrink-0" />
            <span className="text-xs text-red-400">Live mode will send real messages</span>
          </motion.div>
        )}
      </div>

      {/* Max clients */}
      <div>
        <FieldLabel>Max Clients</FieldLabel>
        <SegmentedControl
          options={MAX_OPTIONS}
          value={config.max}
          onChange={set('max')}
          disabled={isRunning}
        />
      </div>

      {/* Speed / delay */}
      <div>
        <FieldLabel>Speed</FieldLabel>
        <SegmentedControl
          options={DELAY_OPTIONS}
          value={config.delay}
          onChange={set('delay')}
          disabled={isRunning}
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 pt-1">
        <motion.button
          whileHover={isIdle ? { scale: 1.02 } : {}}
          whileTap={isIdle ? { scale: 0.98 } : {}}
          onClick={onStart}
          disabled={isRunning}
          className={`
            flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all duration-150
            ${isRunning
              ? 'opacity-40 cursor-not-allowed'
              : 'cursor-pointer hover:brightness-110'
            }
          `}
          style={{
            background: isRunning ? '#22c55e40' : 'linear-gradient(135deg, #16a34a, #22c55e)',
            color: 'white',
          }}
        >
          <Play size={15} />
          Start Run
        </motion.button>

        <motion.button
          whileHover={isRunning ? { scale: 1.02 } : {}}
          whileTap={isRunning ? { scale: 0.98 } : {}}
          onClick={onStop}
          disabled={!isRunning}
          className={`
            flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-all duration-150
            ${!isRunning
              ? 'opacity-40 cursor-not-allowed'
              : 'cursor-pointer hover:brightness-110'
            }
          `}
          style={{
            background: !isRunning ? '#ef444440' : 'linear-gradient(135deg, #b91c1c, #ef4444)',
            color: 'white',
          }}
        >
          <Square size={15} />
          Stop
        </motion.button>
      </div>
    </div>
  );
}
