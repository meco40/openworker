'use client';

interface MissionControlErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function MissionControlError({ error, reset }: MissionControlErrorProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-4">
      <div className="w-full max-w-lg rounded-xl border border-rose-500/30 bg-zinc-950/80 p-6 text-zinc-100">
        <h1 className="text-lg font-semibold text-rose-300">Mission Control Fehler</h1>
        <p className="mt-2 text-sm text-zinc-400">{error.message || 'Unbekannter Fehler'}</p>
        <button
          onClick={reset}
          className="mt-4 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900"
        >
          Erneut versuchen
        </button>
      </div>
    </main>
  );
}
