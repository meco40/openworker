import type { KnowledgeExtractionResult } from '@/server/knowledge/extractor';
import type { Modality } from '@/server/world-model/types';
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

  // Assertions aus extrahierten Fakten. Modalitaet 'reported' (konservativ);
  // Hoeheres Vertrauen nur, wenn der Extract nach bestaetigten Events aussieht.
  const assertions: ProjectedAssertion[] = result.facts.map((fact, index) => {
    const confident =
      result.events.some((event) => event.isConfirmation) || result.meetingLedger.confidence >= 0.8;
    return {
      subject: input.personaId,
      predicate: 'fact',
      objectValue: fact,
      modality: confident ? ('observed' as Modality) : ('reported' as Modality),
      confidence: result.meetingLedger.confidence || 0.7,
      sourceMessageSeq: (result.events[0]?.sourceSeq?.[0] ?? 0) + index,
    };
  });

  // Events aus dem Event-Extractor. Nur nicht-vergangene (geplante) werden als
  // 'planned' uebernommen; Bestaetigungen/Historik werden vom Korrektur-Resolver
  // (Phase 4) behandelt.
  const events: ProjectedEvent[] = result.events
    .filter((event) => !event.isConfirmation)
    .map((event) => ({
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

  const total = assertions.length + events.length + entities.length + relations.length;
  const confident = assertions.filter((a) => a.modality === 'observed').length + events.length;

  return {
    assertions,
    events,
    entities,
    relations,
    openLoops: [],
    tasks: [],
    confidenceSummary: { total, confident },
  };
}
