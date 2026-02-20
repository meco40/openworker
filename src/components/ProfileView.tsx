'use client';

import React, { useState } from 'react';
import type { ControlPlaneMetricsState } from '@/shared/domain/types';
import { useProfile } from '@/components/profile/hooks';
import {
  ProfileHeader,
  ProfileCard,
  UsagePanel,
  LimitEditor,
  ProfileSidebar,
  StatusMessage,
} from '@/components/profile/components';

interface ProfileViewProps {
  metricsState?: ControlPlaneMetricsState;
}

const ProfileView: React.FC<ProfileViewProps> = ({ metricsState }) => {
  const [showLimitEditor, setShowLimitEditor] = useState(false);

  const {
    profile,
    isLoading,
    isSaving,
    statusMessage,
    usage,
    handleSave,
    updateDisplayName,
    updatePrimaryContact,
    updateWorkspaceSlots,
    updateDailyTokenBudget,
  } = useProfile({ metricsState });

  return (
    <div className="animate-in fade-in mx-auto max-w-6xl space-y-10 pb-20 duration-500">
      <ProfileHeader />

      {statusMessage && <StatusMessage message={statusMessage} />}

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
        {/* Profile Card & Usage */}
        <div className="space-y-8 lg:col-span-2">
          <ProfileCard
            profile={profile}
            isLoading={isLoading}
            isSaving={isSaving}
            onUpdateDisplayName={updateDisplayName}
            onUpdatePrimaryContact={updatePrimaryContact}
            onSave={handleSave}
          />

          <UsagePanel
            usage={usage}
            tokensToday={usage.tokensToday}
            dailyTokenBudget={profile.dailyTokenBudget}
          />

          <button
            onClick={() => setShowLimitEditor((previous) => !previous)}
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 py-5 text-[10px] font-black tracking-widest text-zinc-300 uppercase transition-all hover:bg-zinc-800"
          >
            Configure Local Limits
          </button>

          {showLimitEditor && (
            <LimitEditor
              workspaceSlots={profile.workspaceSlots}
              dailyTokenBudget={profile.dailyTokenBudget}
              isSaving={isSaving}
              onUpdateWorkspaceSlots={updateWorkspaceSlots}
              onUpdateDailyTokenBudget={updateDailyTokenBudget}
            />
          )}
        </div>

        {/* Sidebar */}
        <ProfileSidebar />
      </div>
    </div>
  );
};

export default ProfileView;
