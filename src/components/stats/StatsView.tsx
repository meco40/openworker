'use client';

import React, { useCallback, useEffect, useState } from 'react';
import PromptLogsTab from '@/components/stats/PromptLogsTab';
import OverviewTabContent from './OverviewTabContent';
import SessionsTabContent from './SessionsTabContent';
import StatsFilterBar from './StatsFilterBar';
import StatsHeader from './StatsHeader';
import { StatsError, StatsLoading } from './StatsStatus';
import StatsTabs from './StatsTabs';
import type { Preset, StatsResponse, StatsTab } from './types';

const StatsView: React.FC = () => {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [activeTab, setActiveTab] = useState<StatsTab>('overview');
  const [logsReloadKey, setLogsReloadKey] = useState(0);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (preset === 'custom') {
        if (customFrom) params.set('from', new Date(customFrom).toISOString());
        if (customTo) params.set('to', new Date(customTo).toISOString());
      } else {
        params.set('preset', preset);
      }

      if (activeTab === 'sessions') {
        params.set('sessions', '1');
      }

      const response = await fetch(`/api/stats?${params.toString()}`);
      const json = (await response.json()) as StatsResponse;

      if (!json.ok) {
        setError(json.error || 'Failed to load stats.');
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setLoading(false);
    }
  }, [preset, customFrom, customTo, activeTab]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleRefresh = useCallback(() => {
    if (activeTab === 'logs') {
      setLogsReloadKey((prev) => prev + 1);
      return;
    }
    void fetchStats();
  }, [activeTab, fetchStats]);

  return (
    <div className="animate-in fade-in space-y-6 duration-700">
      <StatsHeader onRefresh={handleRefresh} />

      <StatsTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <StatsFilterBar
        preset={preset}
        customFrom={customFrom}
        customTo={customTo}
        onPresetChange={setPreset}
        onCustomFromChange={setCustomFrom}
        onCustomToChange={setCustomTo}
      />

      {activeTab === 'logs' && (
        <PromptLogsTab
          preset={preset}
          customFrom={customFrom}
          customTo={customTo}
          reloadKey={logsReloadKey}
        />
      )}

      {activeTab === 'sessions' && (
        <>
          {loading && <StatsLoading />}
          {error && <StatsError error={error} />}
          {data && !loading && <SessionsTabContent sessionLens={data.sessionLens} />}
        </>
      )}

      {activeTab === 'overview' && (
        <>
          {loading && <StatsLoading />}
          {error && <StatsError error={error} />}
          {data && !loading && <OverviewTabContent data={data} />}
        </>
      )}
    </div>
  );
};

export default StatsView;
