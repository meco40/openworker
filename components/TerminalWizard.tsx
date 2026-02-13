import React, { useState, useEffect, useRef, useMemo } from 'react';

interface TerminalWizardProps {
  onComplete: () => void;
}

const TerminalWizard: React.FC<TerminalWizardProps> = ({ onComplete }) => {
  const [lines, setLines] = useState<string[]>(['$ openclaw onboard']);
  const [step, setStep] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const script = useMemo(
    () => [
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
    ],
    [],
  );

  useEffect(() => {
    if (step < script.length) {
      const timeout = setTimeout(() => {
        setLines((prev) => [...prev, script[step].text]);
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
    <div className="flex h-screen w-screen items-center justify-center bg-black p-4">
      <div className="flex h-[500px] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-zinc-800 bg-[#0c0c0c] shadow-2xl">
        <div className="flex h-8 items-center space-x-2 border-b border-zinc-800 bg-zinc-900 px-4">
          <div className="h-2.5 w-2.5 rounded-full bg-rose-500/50" />
          <div className="h-2.5 w-2.5 rounded-full bg-amber-500/50" />
          <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/50" />
          <div className="ml-4 font-mono text-[10px] tracking-widest text-zinc-600 uppercase">
            CLI: setup-wizard
          </div>
        </div>
        <div
          ref={scrollRef}
          className="flex-1 space-y-1 overflow-y-auto bg-black/40 p-6 font-mono text-sm"
        >
          {lines.map((line, idx) => (
            <div
              key={idx}
              className={
                line.startsWith('$')
                  ? 'font-bold text-white'
                  : line.includes('[OK]')
                    ? 'text-emerald-500'
                    : 'text-zinc-400'
              }
            >
              {line}
            </div>
          ))}
          {!isFinished && <div className="animate-pulse text-white">_</div>}
          {isFinished && (
            <div className="animate-in fade-in pt-6 duration-1000">
              <button
                onClick={onComplete}
                className="rounded bg-emerald-600 px-6 py-2 text-xs font-bold tracking-widest text-white uppercase shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500"
              >
                Launch Control Plane
              </button>
            </div>
          )}
        </div>
        <div className="flex h-6 items-center justify-between border-t border-zinc-800 bg-zinc-900 px-4 font-mono text-[9px] text-zinc-600">
          <span>PROGRESS: {Math.round((step / script.length) * 100)}%</span>
          <span>GATEWAY_STATUS: {isFinished ? 'READY' : 'PROVISIONING'}</span>
        </div>
      </div>
    </div>
  );
};

export default TerminalWizard;
