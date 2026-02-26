function buildSpeakerPrefixes(
  speakerName: string,
  options?: { includePlainLabel?: boolean },
): string[] {
  const normalizedSpeaker = String(speakerName || '').trim();
  if (!normalizedSpeaker) return [];
  const prefixes = [
    `**[${normalizedSpeaker}]:**`,
    `**${normalizedSpeaker}:**`,
    `[${normalizedSpeaker}]:`,
  ];
  if (options?.includePlainLabel ?? true) {
    prefixes.push(`${normalizedSpeaker}:`);
  }
  return prefixes;
}

export function stripLeadingSpeakerPrefix(text: string, speakerName: string): string {
  const raw = String(text || '').trimStart();
  const prefixes = buildSpeakerPrefixes(speakerName);
  if (!raw || prefixes.length === 0) return raw;
  const lowerRaw = raw.toLowerCase();

  for (const prefix of prefixes) {
    if (lowerRaw.startsWith(prefix.toLowerCase())) {
      return raw.slice(prefix.length).trim();
    }
  }

  return raw;
}

export function stripTrailingOtherSpeakerTurns(
  text: string,
  activeSpeakerName: string,
  participantNames: string[],
): string {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const active = String(activeSpeakerName || '')
    .trim()
    .toLowerCase();
  const otherNames = Array.from(
    new Set(
      participantNames
        .map((name) => String(name || '').trim())
        .filter((name) => name && name.toLowerCase() !== active),
    ),
  );
  if (otherNames.length === 0) return raw;

  const lowerRaw = raw.toLowerCase();
  let cutIndex = -1;
  for (const name of otherNames) {
    for (const prefix of buildSpeakerPrefixes(name, { includePlainLabel: false })) {
      const index = lowerRaw.indexOf(prefix.toLowerCase());
      if (index > 0 && (cutIndex === -1 || index < cutIndex)) {
        cutIndex = index;
      }
    }
  }

  if (cutIndex <= 0) return raw;
  return raw.slice(0, cutIndex).trim();
}

export function countStructuredTurns(artifact: string): number {
  const text = String(artifact || '');
  if (!text.trim()) return 0;
  const matches = text.match(/^\s*\*\*\[[^\]\n*]+?\]:\*\*/gm);
  return matches ? matches.length : 0;
}

export function countTurnsInCurrentPhase(artifact: string): number {
  const text = String(artifact || '').trim();
  if (!text) return 0;
  const phaseMarkerRegex = /^---\s+.+?\s+---$/gm;
  let lastMarkerEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = phaseMarkerRegex.exec(text))) {
    lastMarkerEnd = m.index + m[0].length;
  }
  const textAfterMarker = text.slice(lastMarkerEnd);
  const turns = textAfterMarker.match(/^\s*\*\*\[[^\]\n*]+?\]:\*\*/gm);
  return turns ? turns.length : 0;
}

export function extractRecentTurnHistory(artifact: string, maxTurns = 8): string {
  const text = String(artifact || '').trim();
  if (!text) return '';
  const chunks = text.split(/\n{2,}/).filter((chunk) => chunk.trim().length > 0);
  return chunks.slice(-Math.max(1, maxTurns)).join('\n\n');
}
