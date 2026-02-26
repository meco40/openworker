'use client';

import React from 'react';
import type { StatsTab } from './types';

interface StatsTabsProps {
  activeTab: StatsTab;
  onTabChange: (tab: StatsTab) => void;
}

const tabClass = (isActive: boolean): string =>
  `rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
    isActive
      ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
  }`;

const StatsTabs: React.FC<StatsTabsProps> = ({ activeTab, onTabChange }) => (
  <div className="flex items-center space-x-2">
    <button onClick={() => onTabChange('overview')} className={tabClass(activeTab === 'overview')}>
      Overview
    </button>
    <button onClick={() => onTabChange('logs')} className={tabClass(activeTab === 'logs')}>
      Logs
    </button>
    <button onClick={() => onTabChange('sessions')} className={tabClass(activeTab === 'sessions')}>
      Sessions
    </button>
  </div>
);

export default StatsTabs;
