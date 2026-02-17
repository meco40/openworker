/**
 * Store reconciliation — detects orphaned entries between Mem0 and SQLite knowledge.
 *
 * Pure functions for comparing two data stores and finding entries
 * that exist in one but not the other.
 */

export interface StoreEntry {
  id: string;
  content: string;
  externalRef?: string;
}

export interface ReconciliationReport {
  mem0OrphansFound: number;
  knowledgeOrphansFound: number;
  mem0Orphans: StoreEntry[];
  knowledgeOrphans: StoreEntry[];
}

/**
 * Detect orphaned entries between Mem0 and SQLite knowledge stores.
 *
 * - Mem0 orphan: exists in Mem0 but no knowledge entry references it
 * - Knowledge orphan: knowledge entry references a Mem0 ID that doesn't exist
 *
 * @param mem0Entries - All entries from Mem0 for a given scope
 * @param knowledgeEntries - All knowledge entries with their externalRef (Mem0 ID)
 */
export function detectOrphans(
  mem0Entries: StoreEntry[],
  knowledgeEntries: StoreEntry[],
): ReconciliationReport {
  const mem0Ids = new Set(mem0Entries.map((e) => e.id));
  const referencedMem0Ids = new Set(
    knowledgeEntries.filter((e) => e.externalRef).map((e) => e.externalRef),
  );

  // Mem0 orphans: in Mem0 but not referenced by any knowledge entry
  const mem0Orphans = mem0Entries.filter((e) => !referencedMem0Ids.has(e.id));

  // Knowledge orphans: reference a Mem0 ID that doesn't exist
  const knowledgeOrphans = knowledgeEntries.filter(
    (e) => e.externalRef && !mem0Ids.has(e.externalRef),
  );

  return {
    mem0OrphansFound: mem0Orphans.length,
    knowledgeOrphansFound: knowledgeOrphans.length,
    mem0Orphans,
    knowledgeOrphans,
  };
}
