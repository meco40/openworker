
import React from 'react';
import { Skill } from '../types';

interface SkillsRegistryProps {
  skills: Skill[];
  setSkills: React.Dispatch<React.SetStateAction<Skill[]>>;
}

const SkillsRegistry: React.FC<SkillsRegistryProps> = ({ skills, setSkills }) => {
  const handleToggleInstall = (id: string) => {
    const skill = skills.find(s => s.id === id);
    if (!skill) return;
    
    setSkills(prev => prev.map(s => s.id === id ? { ...s, installed: !s.installed } : s));
  };

  return (
    <div className="space-y-10 animate-in fade-in duration-500 pb-20 max-w-6xl mx-auto">
      <header className="flex items-center justify-between bg-zinc-900/40 p-10 rounded-[2.5rem] border border-zinc-800 shadow-2xl relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-600/10 rounded-full blur-[100px] -mr-40 -mt-40" />
        <div className="relative z-10">
          <h2 className="text-3xl font-black text-white tracking-tight uppercase">Skill Registry</h2>
          <p className="text-sm text-zinc-500 mt-2 max-w-md">Extend agent capabilities. Installed skills become active tools in the KI context.</p>
        </div>
        <button className="relative z-10 px-8 py-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border border-zinc-700">
          Sync Skill Repo
        </button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {skills.map(skill => (
          <div key={skill.id} className="bg-zinc-900/60 border border-zinc-800 rounded-[2rem] p-6 flex flex-col h-[280px] relative overflow-hidden group hover:border-indigo-500/50 transition-all shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border ${
                skill.installed ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`}>
                {skill.installed ? 'Runtime: Active' : 'Available'}
              </span>
              <span className="text-[9px] font-mono text-zinc-600">v{skill.version}</span>
            </div>

            <h3 className="font-bold text-white mb-2 text-lg group-hover:text-indigo-400 transition-colors">{skill.name}</h3>
            <p className="text-xs text-zinc-500 line-clamp-3 mb-6 flex-1">{skill.description}</p>
            
            <div className="mt-auto pt-4 border-t border-zinc-800/50 flex items-center justify-between">
              <span className="text-[10px] font-black text-zinc-600 uppercase tracking-tighter">{skill.category}</span>
              <button 
                onClick={() => handleToggleInstall(skill.id)} 
                className={`text-[10px] font-black uppercase tracking-widest transition-all ${
                  skill.installed ? 'text-rose-500 hover:text-rose-400' : 'text-indigo-500 hover:text-indigo-400'
                }`}
              >
                {skill.installed ? 'Decommission' : 'Deploy Skill'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SkillsRegistry;
