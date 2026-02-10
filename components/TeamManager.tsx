
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
      tier: newTeamTier
    };
    setTeams([...teams, team]);
    setNewTeamName('');
    setIsCreating(false);
  };

  const deleteTeam = (id: string) => {
    if (id === 'team-personal') return; // Protect personal
    setTeams(teams.filter(t => t.id !== id));
  };

  const addMember = () => {
    if (!inviteEmail.trim() || !invitingTeamId) return;
    setTeams(prev => prev.map(t => 
      t.id === invitingTeamId ? { ...t, memberCount: t.memberCount + 1 } : t
    ));
    setInviteEmail('');
    setInvitingTeamId(null);
  };

  const getTeamTaskCount = (teamId: string) => {
    return tasks.filter(t => t.teamId === teamId || (teamId === 'team-personal' && !t.teamId)).length;
  };

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700 max-w-6xl mx-auto pb-20">
      <header className="flex items-center justify-between bg-zinc-900/40 p-10 rounded-[2.5rem] border border-zinc-800 shadow-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-600/10 rounded-full blur-[100px] -mr-40 -mt-40" />
        <div className="relative z-10">
          <h2 className="text-4xl font-black text-white tracking-tight uppercase">Organizations</h2>
          <p className="text-sm text-zinc-500 mt-2 max-w-md">Orchestrate cross-functional teams and share autonomous environments.</p>
        </div>
        <button 
          onClick={() => setIsCreating(true)}
          className="relative z-10 px-8 py-5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] transition-all shadow-2xl shadow-indigo-600/30 active:scale-95"
        >
          New Organization
        </button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {teams.map(team => {
          const taskCount = getTeamTaskCount(team.id);
          return (
            <div key={team.id} className="bg-zinc-900/60 border border-zinc-800 p-8 rounded-[2rem] hover:border-indigo-500/50 transition-all group flex flex-col h-[340px] shadow-lg relative overflow-hidden">
              <div className={`absolute top-0 left-0 w-1.5 h-full ${team.tier === 'Enterprise' ? 'bg-amber-500' : team.tier === 'Pro' ? 'bg-indigo-500' : 'bg-zinc-700'}`} />
              
              <div className="flex items-center justify-between mb-6">
                <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border ${
                  team.tier === 'Enterprise' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 
                  team.tier === 'Pro' ? 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                }`}>
                  {team.tier} Tier
                </span>
                {team.id !== 'team-personal' && (
                  <button onClick={() => deleteTeam(team.id)} className="text-zinc-700 hover:text-rose-500 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                )}
              </div>

              <h3 className="text-2xl font-bold text-white mb-2 leading-tight group-hover:text-indigo-400 transition-colors">{team.name}</h3>
              <div className="flex items-center space-x-3 mt-1 text-[10px] font-black uppercase text-zinc-500 tracking-widest">
                 <span>{team.role}</span>
                 <span className="text-zinc-800">|</span>
                 <span className="text-indigo-500">{team.memberCount} Members</span>
                 <span className="text-zinc-800">|</span>
                 <span className="text-emerald-500">{taskCount} Workspaces</span>
              </div>

              <div className="mt-auto space-y-4">
                <div className="flex -space-x-2">
                   {[...Array(Math.min(5, team.memberCount))].map((_, i) => (
                     <div key={i} className="w-8 h-8 rounded-full bg-zinc-800 border-2 border-zinc-950 flex items-center justify-center text-[10px] font-bold text-zinc-500 ring-2 ring-zinc-900">
                       U{i+1}
                     </div>
                   ))}
                </div>
                <div className="flex items-center justify-between pt-4 border-t border-zinc-800/50">
                   <button 
                    onClick={() => setInvitingTeamId(team.id)}
                    className="text-[10px] font-black text-indigo-400 hover:text-indigo-300 uppercase tracking-widest transition-colors flex items-center space-x-1"
                   >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" strokeWidth="3" strokeLinecap="round"/></svg>
                      <span>Invite</span>
                   </button>
                   <button className="text-[10px] font-black text-zinc-500 hover:text-white uppercase tracking-widest flex items-center space-x-2 group/btn">
                      <span>View Org</span>
                      <svg className="w-4 h-4 transform group-hover/btn:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeWidth="2.5"/></svg>
                   </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Team Modal */}
      {isCreating && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md animate-in fade-in duration-300 px-6">
           <div className="bg-zinc-950 border border-zinc-800 rounded-[3rem] p-12 max-w-lg w-full shadow-2xl space-y-10 relative">
              <button onClick={() => setIsCreating(false)} className="absolute top-8 right-8 text-zinc-500 hover:text-white transition-colors">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12" strokeWidth="2.5"/></svg>
              </button>
              
              <div className="space-y-4">
                <div className="w-16 h-16 bg-indigo-600/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center text-3xl">🚀</div>
                <h3 className="text-3xl font-black text-white uppercase tracking-tight">Provision Organization</h3>
                <p className="text-sm text-zinc-500">Scale your automation infrastructure with team collaborative workflows.</p>
              </div>

              <div className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest ml-2">Org Alias</label>
                    <input 
                      autoFocus
                      type="text"
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                      placeholder="Ex: Cybernetics Labs..."
                      className="w-full bg-zinc-900 border border-zinc-800 focus:border-indigo-500 rounded-2xl p-5 text-lg text-white outline-none transition-all"
                    />
                 </div>

                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest ml-2">Node Tier</label>
                    <div className="grid grid-cols-3 gap-3">
                       {['Starter', 'Pro', 'Enterprise'].map(t => (
                         <button 
                          key={t}
                          onClick={() => setNewTeamTier(t as any)}
                          className={`py-3 rounded-xl text-[9px] font-black uppercase transition-all border ${newTeamTier === t ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg' : 'bg-zinc-900 border-zinc-800 text-zinc-500'}`}
                         >
                           {t}
                         </button>
                       ))}
                    </div>
                 </div>
                 
                 <div className="flex gap-4 pt-4">
                    <button 
                      onClick={() => setIsCreating(false)}
                      className="flex-1 py-5 bg-zinc-900 text-zinc-500 hover:text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={createTeam}
                      disabled={!newTeamName.trim()}
                      className="flex-1 py-5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-2xl disabled:opacity-30"
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
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md animate-in fade-in duration-300 px-6">
           <div className="bg-zinc-950 border border-zinc-800 rounded-[3rem] p-12 max-w-lg w-full shadow-2xl space-y-10 relative">
              <div className="space-y-4">
                <div className="w-16 h-16 bg-emerald-600/10 border border-emerald-500/20 rounded-2xl flex items-center justify-center text-3xl">✉️</div>
                <h3 className="text-3xl font-black text-white uppercase tracking-tight">Invite Collaborator</h3>
                <p className="text-sm text-zinc-500">Send an invitation to join this organization node.</p>
              </div>

              <div className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest ml-2">Email Address</label>
                    <input 
                      autoFocus
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="user@example.com"
                      className="w-full bg-zinc-900 border border-zinc-800 focus:border-emerald-500 rounded-2xl p-5 text-lg text-white outline-none transition-all"
                    />
                 </div>
                 
                 <div className="flex gap-4">
                    <button onClick={() => setInvitingTeamId(null)} className="flex-1 py-5 bg-zinc-900 text-zinc-500 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all">Cancel</button>
                    <button onClick={addMember} disabled={!inviteEmail.trim()} className="flex-1 py-5 bg-emerald-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-2xl disabled:opacity-30">Send Invite</button>
                 </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default TeamManager;
