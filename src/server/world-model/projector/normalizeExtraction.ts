import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type {
  ProjectedAssertion,
  ProjectedEntity,
  ProjectedEvent,
  ProjectedRelation,
  WorldModelProjection,
} from '@/server/world-model/projector/types';

/**
 * Phase 3: Ueberfuehrt das bestehende Extraction-Ergebnis (Knowledge Layer)
 * in die normalisierte World-Model-Projektion, ohne beim Speichern erneut
 * LLM-Ausgaben zu interpretieren. Confidence/Modalitaet werden aus den
 * Extractors uebernommen bzw. konservativ gesetzt.
 */
export interface NormalizeExtractionInput {
  result: KnowledgeExtractionResult;
  workspaceId: string;
  userId: string;
  personaId: string;
}

export function normalizeExtraction(input: NormalizeExtractionInput): WorldModelProjection {
  const { result } = input;

  // Ein bestaetigtes Event bestaetigt nicht automatisch alle daneben
  // extrahierten Fakten. Ohne eigene Evidenz bleiben sie reported.
  const assertions: ProjectedAssertion[] = result.facts.map((fact, index) => {
    return {
      subject: input.personaId,
      predicate: 'fact',
      objectValue: fact,
      modality: 'reported',
      confidence: result.meetingLedger.confidence || 0.7,
      sourceMessageSeq: (result.events[0]?.sourceSeq?.[0] ?? 0) + index,
    };
  });

  // Events aus dem Event-Extractor. Alle Events werden als 'planned' in die
  // Projektion uebernommen; Bestaetigungen, Absagen und Aenderungen werden vom
  // eventLinker / Korrektur-Resolver (Phase 4) in projectWindow aufgeloest.
  const events: ProjectedEvent[] = result.events.map((event) => ({
    title: event.subject || event.eventType,
    eventType: event.eventType,
    scheduledFor: event.startDate || undefined,
    endsAt: event.endDate || undefined,
    status: 'planned',
    sourceMessageSeq: event.sourceSeq?.[0] ?? 0,
  }));

  // Entities + Relations.
  const entities: ProjectedEntity[] = result.entities.map((entity) => ({
    canonicalName: entity.name,
    category: entity.category,
    owner: entity.owner,
    aliases: entity.aliases ?? [],
    sourceMessageSeq: entity.sourceSeq?.[0] ?? 0,
  }));

  const relations: ProjectedRelation[] = result.entities.flatMap((entity) =>
    (entity.relations ?? []).map((relation) => ({
      sourceEntity: entity.name,
      targetEntity: relation.targetName,
      relationType: relation.relationType,
      confidence: entity.sourceSeq?.[0] ? 0.8 : 0.7,
      sourceMessageSeq: entity.sourceSeq?.[0] ?? 0,
    })),
  );

  const tasks = result.meetingLedger.actionItems.map((title, index) => ({
    title,
    requester: input.userId,
    assignee: input.personaId,
    sourceMessageSeq: (result.events[0]?.sourceSeq?.[0] ?? 0) + index,
  }));
  const openLoops = result.meetingLedger.openPoints.map((question, index) => ({
    type: 'missing_context' as const,
    question,
    deduplicationKey: question,
    sourceMessageSeq: (result.events[0]?.sourceSeq?.[0] ?? 0) + index,
  }));

  const total =
    assertions.length + events.length + entities.length + relations.length + tasks.length;
  const confident = events.length;

  return {
    assertions,
    events,
    entities,
    relations,
    openLoops,
    tasks,
    confidenceSummary: { total, confident },
  };
}
