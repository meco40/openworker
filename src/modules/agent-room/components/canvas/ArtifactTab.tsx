'use client';

import { InlineMarkdown } from '@/modules/agent-room/components/InlineMarkdown';

interface ArtifactTabProps {
  artifact: string;
}

export function ArtifactTab({ artifact }: ArtifactTabProps) {
  if (!artifact) {
    return <p className="text-sm text-zinc-500 italic">No artifact yet.</p>;
  }
  return <InlineMarkdown text={artifact} className="text-[11px] leading-relaxed text-zinc-300" />;
}
