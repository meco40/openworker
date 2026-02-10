
import React, { useState, useEffect, useRef, useMemo } from 'react';

interface TerminalWizardProps {
  onComplete: () => void;
}

const TerminalWizard: React.FC<TerminalWizardProps> = ({ onComplete }) => {
  const [lines, setLines] = useState<string[]>(['$ openclaw onboard']);
  const [step, setStep] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const script = useMemo(() => [
    { text: 'Initializing OpenClaw Onboarding Wizard...', delay: 400 },
    { text: 'Checking system requirements... [OK]', delay: 600 },
    { text: 'Connecting to local Gateway process... [OK]', delay: 300 },
    { text: 'Step 1/3: Workspace Configuration', delay: 200 },
    { text: 'Found ~/.openclaw/workspace. Creating registry...', delay: 400 },
    { text: 'Step 2/3: Provider Auth', delay: 200 },
    { text: 'Configuring Gemini API key... [FOUND in ENV]', delay: 800 },
    { text: 'Step 3/3: Channel Setup', delay: 200 },
    { text: 'Enabling WebChat, Telegram and Slack plugins...', delay: 500 },
    { text: 'Finalizing installation as daemon...', delay: 800 },
    { text: 'OpenClaw Gateway is now ready for duty.', delay: 300 },
    { text: 'Starting Control UI...', delay: 500 },
  ], []);

  useEffect(() => {
    if (step < script.length) {
      const timeout = setTimeout(() => {
        setLines(prev => [...prev, script[step].text]);
        setStep(step + 1);
      }, script[step].delay);
      return () => clearTimeout(timeout);
    } else {
      setIsFinished(true);
      const finalTimeout = setTimeout(onComplete, 1000);
      return () => clearTimeout(finalTimeout);
    }
  }, [step, script, onComplete]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="h-screen w-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-3xl bg-[#0c0c0c] border border-zinc-800 rounded-lg shadow-2xl overflow-hidden flex flex-col h-[500px]">
        <div className="h-8 bg-zinc-900 flex items-center px-4 space-x-2 border-b border-zinc-800">
          <div className="w-2.5 h-2.5 rounded-full bg-rose-500/50" />
          <div className="w-2.5 h-2.5 rounded-full bg-amber-500/50" />
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/50" />
          <div className="ml-4 text-[10px] font-mono text-zinc-600 uppercase tracking-widest">CLI: setup-wizard</div>
        </div>
        <div ref={scrollRef} className="flex-1 p-6 font-mono text-sm overflow-y-auto space-y-1 bg-black/40">
          {lines.map((line, idx) => (
            <div key={idx} className={line.startsWith('$') ? 'text-white font-bold' : line.includes('[OK]') ? 'text-emerald-500' : 'text-zinc-400'}>
              {line}
            </div>
          ))}
          {!isFinished && (
            <div className="text-white animate-pulse">_</div>
          )}
          {isFinished && (
            <div className="pt-6 animate-in fade-in duration-1000">
               <button 
                onClick={onComplete}
                className="px-6 py-2 bg-emerald-600 text-white text-xs font-bold uppercase tracking-widest rounded hover:bg-emerald-500 transition-all shadow-lg shadow-emerald-500/20"
               >
                 Launch Control Plane
               </button>
            </div>
          )}
        </div>
        <div className="h-6 bg-zinc-900 border-t border-zinc-800 px-4 flex items-center justify-between text-[9px] text-zinc-600 font-mono">
          <span>PROGRESS: {Math.round((step / script.length) * 100)}%</span>
          <span>GATEWAY_STATUS: {isFinished ? 'READY' : 'PROVISIONING'}</span>
        </div>
      </div>
    </div>
  );
};

export default TerminalWizard;
