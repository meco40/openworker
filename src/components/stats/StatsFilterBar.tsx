'use client';

import React from 'react';
import type { Preset } from './types';

interface StatsFilterBarProps {
  preset: Preset;
  customFrom: string;
  customTo: string;
  onPresetChange: (preset: Preset) => void;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
}

const presetClass = (isActive: boolean): string =>
  `rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
    isActive
      ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
  }`;

const StatsFilterBar: React.FC<StatsFilterBarProps> = ({
  preset,
  customFrom,
  customTo,
  onPresetChange,
  onCustomFromChange,
  onCustomToChange,
}) => (
  <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
    <div className="flex flex-wrap items-center space-x-2 gap-y-2">
      <span className="mr-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
        Filter
      </span>
      {(['today', 'week', 'month'] as const).map((presetOption) => (
        <button
          key={presetOption}
          onClick={() => onPresetChange(presetOption)}
          className={presetClass(preset === presetOption)}
        >
          {presetOption === 'today'
            ? 'Heute'
            : presetOption === 'week'
              ? 'Diese Woche'
              : 'Dieser Monat'}
        </button>
      ))}
      <button onClick={() => onPresetChange('custom')} className={presetClass(preset === 'custom')}>
        Zeitraum
      </button>

      {preset === 'custom' && (
        <div className="ml-4 flex items-center space-x-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => onCustomFromChange(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none"
          />
          <span className="text-xs text-zinc-600">–</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => onCustomToChange(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none"
          />
        </div>
      )}
    </div>
  </div>
);

export default StatsFilterBar;
