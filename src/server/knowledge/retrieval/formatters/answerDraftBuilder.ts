import type { KnowledgeEpisode, MeetingLedgerEntry } from '@/server/knowledge/repository';
import { uniqueStrings } from '../utils/arrayUtils';
import { isRuleLikeStatement, extractRuleFragments } from '../query/rulesExtractor';
import { toDisplayName } from './displayUtils';

export interface AnswerDraftInput {
  rulesIntent: boolean;
  ledgerRows: MeetingLedgerEntry[];
  episodes: KnowledgeEpisode[];
  counterpart: string | null;
  computedAnswerText: string | null;
  entityContextSection: string;
  semanticContext: string;
  keyDecisionsList: string[];
  openPointsList: string[];
}

export function buildAnswerDraft(input: AnswerDraftInput): string[] {
  const {
    rulesIntent,
    ledgerRows,
    episodes,
    counterpart,
    computedAnswerText,
    entityContextSection,
    semanticContext,
    keyDecisionsList,
    openPointsList,
  } = input;

  if (rulesIntent) {
    const ruleHighlights = uniqueStrings([
      ...keyDecisionsList,
      ...openPointsList,
      ...episodes.flatMap((episode) =>
        extractRuleFragments(
          `${episode.teaser || ''}\n${episode.episode || ''}\n${(episode.facts || []).join('\n')}`,
        ),
      ),
      ...ledgerRows.flatMap((row) =>
        extractRuleFragments(
          `${row.decisions.join('\n')}\n${row.negotiatedTerms.join('\n')}\n${row.openPoints.join(
            '\n',
          )}\n${row.actionItems.join('\n')}`,
        ),
      ),
      ...extractRuleFragments(semanticContext),
    ]).slice(0, 8);

    return ['Kontext: Regelwissen aus Historie.', ...ruleHighlights.map((entry) => `- ${entry}`)];
  }

  const latestEpisode = episodes[0];
  return [
    ...(computedAnswerText ? [computedAnswerText] : []),
    ...(entityContextSection ? [`[Entity-Kontext]\n${entityContextSection}`] : []),
    counterpart
      ? `Kontext: Meeting mit ${counterpart}.`
      : 'Kontext: Wissensrueckgriff aktiv.',
    latestEpisode?.teaser || '',
    semanticContext || '',
  ];
}

export function filterListsForRulesIntent(
  rulesIntent: boolean,
  keyDecisionsList: string[],
  openPointsList: string[],
): { keyDecisions: string[]; openPoints: string[] } {
  if (!rulesIntent) {
    return { keyDecisions: keyDecisionsList, openPoints: openPointsList };
  }
  return {
    keyDecisions: keyDecisionsList.filter((entry) => isRuleLikeStatement(entry)),
    openPoints: openPointsList.filter((entry) => isRuleLikeStatement(entry)),
  };
}

export function extractCounterpartAndLists(
  ledgerRows: MeetingLedgerEntry[],
  episodes: KnowledgeEpisode[],
  planCounterpart: string | undefined,
): {
  counterpart: string | null;
  keyDecisionsList: string[];
  openPointsList: string[];
} {
  const latestEpisode = episodes[0];
  const keyDecisionsList = uniqueStrings([
    ...ledgerRows.flatMap((row) => row.decisions),
    ...ledgerRows.flatMap((row) => row.negotiatedTerms),
    ...(latestEpisode?.facts || []),
  ]);

  const openPointsList = uniqueStrings([
    ...ledgerRows.flatMap((row) => row.openPoints),
    ...ledgerRows.flatMap((row) => row.actionItems),
  ]);

  const counterpart = toDisplayName(
    ledgerRows[0]?.counterpart || latestEpisode?.counterpart || planCounterpart,
  );

  return { counterpart, keyDecisionsList, openPointsList };
}
