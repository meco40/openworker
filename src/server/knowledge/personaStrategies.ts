/**
 * Persona Memory Strategies — type-specific extraction, recall ranking, and summary styles.
 *
 * Each persona archetype has fundamentally different memory needs:
 * - RolePlay: Emotions, relationships, narrative continuity
 * - Builder: Projects, milestones, tech decisions
 * - Assistant: Tasks, deadlines, preferences
 * - General: Balanced approach
 */

import type { PersonaType } from '@/server/personas/personaTypes';
export type { PersonaType };

export interface PersonaMemoryStrategy {
  personaType: PersonaType;
  extractionPromptAddition: string;
  recallWeights: {
    emotionalRelevance: number; // 0.0–1.0
    recency: number;
    taskRelevance: number;
    projectRelevance: number;
  };
  preferredMemoryTypes: string[];
  summaryStyle: 'narrative' | 'status_report' | 'task_list' | 'balanced';
  consolidationAggressiveness: 'conservative' | 'moderate' | 'aggressive';
}

export const PERSONA_STRATEGIES: Record<PersonaType, PersonaMemoryStrategy> = {
  roleplay: {
    personaType: 'roleplay',
    extractionPromptAddition: `
ROLEPLAY-MODUS:
- Emotionale Zustaende explizit extrahieren
- Beziehungs-Updates priorisieren
- Narrative Kontinuitaet beachten
- Traum-Sequenzen als solche markieren`,
    recallWeights: {
      emotionalRelevance: 0.9,
      recency: 0.6,
      taskRelevance: 0.1,
      projectRelevance: 0.1,
    },
    preferredMemoryTypes: ['emotional_event', 'relationship_update', 'shared_experience', 'fact'],
    summaryStyle: 'narrative',
    consolidationAggressiveness: 'conservative',
  },

  builder: {
    personaType: 'builder',
    extractionPromptAddition: `
BUILDER-MODUS:
- Projekt-Milestones extrahieren
- Tech-Entscheidungen festhalten
- Bug-Reports und Loesungen als Paar speichern
- Projekt-Status tracken`,
    recallWeights: {
      emotionalRelevance: 0.1,
      recency: 0.8,
      taskRelevance: 0.7,
      projectRelevance: 0.9,
    },
    preferredMemoryTypes: ['project_milestone', 'tech_decision', 'bug_report', 'code_reference'],
    summaryStyle: 'status_report',
    consolidationAggressiveness: 'aggressive',
  },

  assistant: {
    personaType: 'assistant',
    extractionPromptAddition: `
ASSISTENT-MODUS:
- Termine und Deadlines als strukturierte Tasks extrahieren
- Erledigungs-Signale erkennen
- Bei Terminen: Datum, Uhrzeit, Ort
- Preferences langfristig merken`,
    recallWeights: {
      emotionalRelevance: 0.3,
      recency: 0.9,
      taskRelevance: 0.9,
      projectRelevance: 0.3,
    },
    preferredMemoryTypes: ['task', 'deadline', 'preference', 'recurring_pattern', 'fact'],
    summaryStyle: 'task_list',
    consolidationAggressiveness: 'moderate',
  },

  general: {
    personaType: 'general',
    extractionPromptAddition: '',
    recallWeights: {
      emotionalRelevance: 0.5,
      recency: 0.7,
      taskRelevance: 0.5,
      projectRelevance: 0.5,
    },
    preferredMemoryTypes: ['fact', 'event', 'preference'],
    summaryStyle: 'balanced',
    consolidationAggressiveness: 'moderate',
  },
};

interface NodeMetadata {
  emotionalTone?: string;
  type?: string;
}

/**
 * Adjusts a node's recall score based on the persona's strategy weights.
 */
export function adjustScoreByStrategy(
  baseScore: number,
  personaType: PersonaType,
  metadata: NodeMetadata,
): number {
  const strategy = PERSONA_STRATEGIES[personaType] ?? PERSONA_STRATEGIES.general;
  let adjusted = baseScore;

  // Emotional relevance boost
  if (metadata.emotionalTone) {
    adjusted *= 1.0 + strategy.recallWeights.emotionalRelevance * 0.3;
  }

  // Task relevance boost
  if (metadata.type === 'task' || metadata.type === 'deadline') {
    adjusted *= 1.0 + strategy.recallWeights.taskRelevance * 0.4;
  }

  // Project relevance boost
  if (metadata.type === 'project_milestone' || metadata.type === 'tech_decision') {
    adjusted *= 1.0 + strategy.recallWeights.projectRelevance * 0.4;
  }

  return adjusted;
}
