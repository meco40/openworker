'use client';

interface ArtifactTabProps {
  artifact: string;
}

export function ArtifactTab({ artifact }: ArtifactTabProps) {
  return (
    <pre className="text-[11px] leading-relaxed wrap-break-word whitespace-pre-wrap text-zinc-300">
      {artifact || 'No artifact yet.'}
    </pre>
  );
}
