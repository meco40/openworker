'use client';

import React from 'react';

export const StatsLoading: React.FC = () => (
  <div className="flex items-center justify-center py-16">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
  </div>
);

interface StatsErrorProps {
  error: string;
}

export const StatsError: React.FC<StatsErrorProps> = ({ error }) => (
  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
    {error}
  </div>
);
