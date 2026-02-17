'use client';

import React from 'react';
import type { OperatorProfileState } from '../../../src/modules/profile/operatorProfileConfig';

interface ProfileCardProps {
  profile: OperatorProfileState;
  isLoading: boolean;
  isSaving: boolean;
  onUpdateDisplayName: (value: string) => void;
  onUpdatePrimaryContact: (value: string) => void;
  onSave: () => void;
}

export const ProfileCard: React.FC<ProfileCardProps> = ({
  profile,
  isLoading,
  isSaving,
  onUpdateDisplayName,
  onUpdatePrimaryContact,
  onSave,
}) => {
  return (
    <div className="flex flex-col items-start gap-10 rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl md:flex-row">
      <div className="flex shrink-0 flex-col items-center space-y-4">
        <div className="flex h-40 w-40 items-center justify-center rounded-[2rem] bg-gradient-to-br from-indigo-600 to-violet-700 text-6xl font-black text-white shadow-[0_0_50px_rgba(79,70,229,0.3)]">
          C
        </div>
        <button className="text-[10px] font-black tracking-widest text-indigo-400 uppercase transition-colors hover:text-indigo-300">
          Update Avatar
        </button>
      </div>

      <div className="w-full flex-1 space-y-6">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Display Name
            </label>
            <input
              type="text"
              value={profile.displayName}
              onChange={(event) => onUpdateDisplayName(event.target.value)}
              disabled={isLoading || isSaving}
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-white transition-all focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
              Local UUID
            </label>
            <input
              type="text"
              readOnly
              value={profile.localUuid || 'Will be generated on save'}
              className="w-full cursor-not-allowed rounded-2xl border border-zinc-800 bg-zinc-900 p-4 font-mono text-sm text-zinc-500"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
            Primary Contact
          </label>
          <input
            type="email"
            value={profile.primaryContact}
            onChange={(event) => onUpdatePrimaryContact(event.target.value)}
            disabled={isLoading || isSaving}
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-white transition-all focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex space-x-4 border-t border-zinc-800 pt-6">
          <button
            onClick={() => void onSave()}
            disabled={isLoading || isSaving}
            className="flex-1 rounded-2xl bg-indigo-600 py-4 text-[10px] font-black tracking-widest text-white uppercase shadow-xl shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
          <button className="rounded-2xl border border-zinc-800 bg-zinc-900 px-8 py-4 text-[10px] font-black tracking-widest text-zinc-400 uppercase transition-all hover:border-rose-500/30 hover:bg-rose-900/20 hover:text-rose-500">
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};
