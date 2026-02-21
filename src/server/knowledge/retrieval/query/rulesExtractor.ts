import { containsRulesWord, normalizeLookupText } from './intentDetector';
import { uniqueStrings } from '../utils/arrayUtils';

function truncateText(value: string, maxChars: number): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

export function isRuleLikeStatement(value: string): boolean {
  const normalized = normalizeLookupText(value);
  if (!normalized) return false;
  if (
    /\b(ohne|kein|keine|keinen|nicht)\b.{0,24}\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (/^\s*\d+\s*[.)-]/.test(value)) return true;
  if (/^\s*(regeln?|rules?|richtlinien?|vorgaben?)\b.{0,24}[:-]/i.test(value)) return true;
  if (
    containsRulesWord(normalized) &&
    /\b(regel|regeln|rule|rules|richtlinie|richtlinien|policy|policies|vorgabe|vorgaben)\b.{0,28}(\d+\s*[.)]|gilt|gelten|lauten|sind)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

export function extractRuleFragments(text: string, maxFragments = 6): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const compact = raw.replace(/\s+/g, ' ').trim();

  const numberedRuleCandidates: string[] = [];
  const rulesHeaderMatch = /(regeln?|rules?|richtlinien?|vorgaben?)\s*:/i.exec(compact);
  const numberedScanSource = rulesHeaderMatch ? compact.slice(rulesHeaderMatch.index) : compact;
  const numberedParts = numberedScanSource.split(/\s(?=\d+\s*[.)-]\s)/);
  for (const part of numberedParts) {
    let candidate = part
      .replace(/^(regeln?|rules?|richtlinien?|vorgaben?)\s*:\s*/i, '')
      .replace(/^Abschnitt\s+\d+:\s*/i, '')
      .trim();
    if (!/^\d+\s*[.)-]\s+/.test(candidate)) continue;
    candidate = truncateText(candidate, 220);
    if (candidate.replace(/[0-9.\-\s]/g, '').length < 4) continue;
    numberedRuleCandidates.push(candidate);
    if (numberedRuleCandidates.length >= maxFragments) break;
  }
  if (numberedRuleCandidates.length > 0) {
    return uniqueStrings(numberedRuleCandidates);
  }

  const segments = raw
    .split(/\r?\n+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/^Abschnitt\s+\d+:\s*/i, '').trim())
    .filter((part) => part.length > 0);

  const picks: string[] = [];
  for (const segment of segments) {
    if (/^\s*\d+\s*[.)-]?\s*$/.test(segment)) continue;
    if (segment.replace(/[0-9.\-\s]/g, '').length < 4) continue;
    if (
      segment.length > 260 &&
      !/^\s*(regeln?|rules?|richtlinien?|vorgaben?)\b/i.test(segment) &&
      !/^\s*\d+\s*[.)-]/.test(segment)
    ) {
      continue;
    }
    if (!isRuleLikeStatement(segment)) continue;
    picks.push(truncateText(segment, 220));
    if (picks.length >= maxFragments) break;
  }
  return uniqueStrings(picks);
}
