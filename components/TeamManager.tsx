import React, { useState } from 'react';
import { Team, WorkerTask } from '../types';

interface TeamManagerProps {
  teams: Team[];
  setTeams: React.Dispatch<React.SetStateAction<Team[]>>;
  tasks: WorkerTask[];
}

const TeamManager: React.FC<TeamManagerProps> = ({ teams, setTeams, tasks }) => {
  const [isCreating, setIsCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamTier, setNewTeamTier] = useState<Team['tier']>('Starter');
  const [invitingTeamId, setInvitingTeamId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');

  const createTeam = () => {
    if (!newTeamName.trim()) return;
    const team: Team = {
      id: `team-${Date.now()}`,
      name: newTeamName,
      role: 'Admin',
      memberCount: 1,
      workspaces: [],
      tier: newTeamTier,
    };
    setTeams([...teams, team]);
    setNewTeamName('');
    setIsCreating(false);
  };

  const deleteTeam = (id: string) => {
    if (id === 'team-personal') return; // Protect personal
    setTeams(teams.filter((t) => t.id !== id));
  };

  const addMember = () => {
    if (!inviteEmail.trim() || !invitingTeamId) return;
    setTeams((prev) =>
      prev.map((t) => (t.id === invitingTeamId ? { ...t, memberCount: t.memberCount + 1 } : t)),
    );
    setInviteEmail('');
    setInvitingTeamId(null);
  };

  const getTeamTaskCount = (teamId: string) => {
    // Tasks are not team-scoped yet; show all for personal team
    return teamId === 'team-personal' ? tasks.length : 0;
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 mx-auto max-w-6xl space-y-10 pb-20 duration-700">
      <header className="group relative flex items-center justify-between overflow-hidden rounded-[2.5rem] border border-zinc-800 bg-zinc-900/40 p-10 shadow-2xl">
        <div className="absolute top-0 right-0 -mt-40 -mr-40 h-80 w-80 rounded-full bg-indigo-600/10 blur-[100px]" />
        <div className="relative z-10">
          <h2 className="text-4xl font-black tracking-tight text-white uppercase">Organizations</h2>
          <p className="mt-2 max-w-md text-sm text-zinc-500">
            Orchestrate cross-functional teams and share autonomous environments.
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="relative z-10 rounded-2xl bg-indigo-600 px-8 py-5 text-[10px] font-black tracking-[0.2em] text-white uppercase shadow-2xl shadow-indigo-600/30 transition-all hover:bg-indigo-500 active:scale-95"
        >
          New Organization
        </button>
      </header>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
        {teams.map((team) => {
          const taskCount = getTeamTaskCount(team.id);
          return (
            <div
              key={team.id}
              className="group relative flex h-[340px] flex-col overflow-hidden rounded-[2rem] border border-zinc-800 bg-zinc-900/60 p-8 shadow-lg transition-all hover:border-indigo-500/50"
            >
              <div
                className={`absolute top-0 left-0 h-full w-1.5 ${team.tier === 'Enterprise' ? 'bg-amber-500' : team.tier === 'Pro' ? 'bg-indigo-500' : 'bg-zinc-700'}`}
              />

              <div className="mb-6 flex items-center justify-between">
                <span
                  className={`rounded border px-2 py-0.5 text-[8px] font-black uppercase ${
                    team.tier === 'Enterprise'
                      ? 'border-amber-500/20 bg-amber-500/10 text-amber-500'
                      : team.tier === 'Pro'
                        ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-500'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {team.tier} Tier
                </span>
                {team.id !== 'team-personal' && (
                  <button
                    onClick={() => deleteTeam(team.id)}
                    className="text-zinc-700 transition-colors hover:text-rose-500"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>

              <h3 className="mb-2 text-2xl leading-tight font-bold text-white transition-colors group-hover:text-indigo-400">
                {team.name}
              </h3>
              <div className="mt-1 flex items-center space-x-3 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                <span>{team.role}</span>
                <span className="text-zinc-800">|</span>
                <span className="text-indigo-500">{team.memberCount} Members</span>
                <span className="text-zinc-800">|</span>
                <span className="text-emerald-500">{taskCount} Workspaces</span>
              </div>

              <div className="mt-auto space-y-4">
                <div className="flex -space-x-2">
                  {[...Array(Math.min(5, team.memberCount))].map((_, i) => (
                    <div
                      key={i}
                      className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-zinc-950 bg-zinc-800 text-[10px] font-bold text-zinc-500 ring-2 ring-zinc-900"
                    >
                      U{i + 1}
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-zinc-800/50 pt-4">
                  <button
                    onClick={() => setInvitingTeamId(team.id)}
                    className="flex items-center space-x-1 text-[10px] font-black tracking-widest text-indigo-400 uppercase transition-colors hover:text-indigo-300"
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path d="M12 4v16m8-8H4" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span>Invite</span>
                  </button>
                  <button className="group/btn flex items-center space-x-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase hover:text-white">
                    <span>View Org</span>
                    <svg
                      className="h-4 w-4 transform transition-transform group-hover/btn:translate-x-1"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeWidth="2.5" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Team Modal */}
      {isCreating && (
        <div className="animate-in fade-in fixed inset-0 z-[100] flex items-center justify-center bg-black/90 px-6 backdrop-blur-md duration-300">
          <div className="relative w-full max-w-lg space-y-10 rounded-[3rem] border border-zinc-800 bg-zinc-950 p-12 shadow-2xl">
            <button
              onClick={() => setIsCreating(false)}
              className="absolute top-8 right-8 text-zinc-500 transition-colors hover:text-white"
            >
              <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M6 18L18 6M6 6l12 12" strokeWidth="2.5" />
              </svg>
            </button>

            <div className="space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-600/10 text-3xl">
                🚀
              </div>
              <h3 className="text-3xl font-black tracking-tight text-white uppercase">
                Provision Organization
              </h3>
              <p className="text-sm text-zinc-500">
                Scale your automation infrastructure with team collaborative workflows.
              </p>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Org Alias
                </label>
                <input
                  autoFocus
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  placeholder="Ex: Cybernetics Labs..."
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-5 text-lg text-white transition-all outline-none focus:border-indigo-500"
                />
              </div>

              <div className="space-y-2">
                <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Node Tier
                </label>
                <div className="grid grid-cols-3 gap-3">
                  {['Starter', 'Pro', 'Enterprise'].map((t) => (
                    <button
                      key={t}
                      onClick={() => setNewTeamTier(t as any)}
                      className={`rounded-xl border py-3 text-[9px] font-black uppercase transition-all ${newTeamTier === t ? 'border-indigo-500 bg-indigo-600 text-white shadow-lg' : 'border-zinc-800 bg-zinc-900 text-zinc-500'}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-4 pt-4">
                <button
                  onClick={() => setIsCreating(false)}
                  className="flex-1 rounded-2xl bg-zinc-900 py-5 text-[10px] font-black tracking-widest text-zinc-500 uppercase transition-all hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={createTeam}
                  disabled={!newTeamName.trim()}
                  className="flex-1 rounded-2xl bg-indigo-600 py-5 text-[10px] font-black tracking-widest text-white uppercase shadow-2xl transition-all hover:bg-indigo-500 disabled:opacity-30"
                >
                  Authorize Deployment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Invite Member Modal */}
      {invitingTeamId && (
        <div className="animate-in fade-in fixed inset-0 z-[100] flex items-center justify-center bg-black/90 px-6 backdrop-blur-md duration-300">
          <div className="relative w-full max-w-lg space-y-10 rounded-[3rem] border border-zinc-800 bg-zinc-950 p-12 shadow-2xl">
            <div className="space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-600/10 text-3xl">
                ✉️
              </div>
              <h3 className="text-3xl font-black tracking-tight text-white uppercase">
                Invite Collaborator
              </h3>
              <p className="text-sm text-zinc-500">
                Send an invitation to join this organization node.
              </p>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="ml-2 text-[10px] font-black tracking-widest text-zinc-500 uppercase">
                  Email Address
                </label>
                <input
                  autoFocus
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-5 text-lg text-white transition-all outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex gap-4">
                <button
                  onClick={() => setInvitingTeamId(null)}
                  className="flex-1 rounded-2xl bg-zinc-900 py-5 text-[10px] font-black tracking-widest text-zinc-500 uppercase transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={addMember}
                  disabled={!inviteEmail.trim()}
                  className="flex-1 rounded-2xl bg-emerald-600 py-5 text-[10px] font-black tracking-widest text-white uppercase shadow-2xl transition-all disabled:opacity-30"
                >
                  Send Invite
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TeamManager;
