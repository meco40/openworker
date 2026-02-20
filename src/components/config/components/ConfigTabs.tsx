'use client';

import React from 'react';
import type { ConfigTab } from '@/components/config/types';
import { TAB_ITEMS } from '@/components/config/types';

interface ConfigTabsProps {
  activeTab: ConfigTab;
  onTabChange: (tab: ConfigTab) => void;
}

export const ConfigTabs: React.FC<ConfigTabsProps> = ({ activeTab, onTabChange }) => {
  return (
    <div className="flex flex-wrap gap-2">
      {TAB_ITEMS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`rounded border px-3 py-2 text-[11px] font-bold tracking-widest uppercase ${
            activeTab === tab.id
              ? 'border-indigo-500/40 bg-indigo-600/20 text-indigo-300'
              : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};
