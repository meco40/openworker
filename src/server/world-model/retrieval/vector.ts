import { getWorldModelDb } from '@/server/world-model/db';
import { getWorldModelConfig } from '@/server/world-model/config';

/**
 * Phase 11: pgvector Retrieval.
 *
 * Fuehrt semantische Aehnlichkeitssuche ueber die world_model_embeddings-Tabelle
 * durch. Nutzt pgvector's cosine distance operator (<=>) fuer Ranking.
 *
 * Voraussetzung: Der Embedding-Worker hat Embeddings fuer die angefragten
 * Entitaeten erzeugt.
 */

export interface VectorHit {
  targetType: string;
  targetId: string;
  text: string;
  similarity: number; // 0..1, hoeher = aehnlicher
  model: string;
  modelVersion: string;
}

/**
 * Fuehrt eine Vektor-Aehnlichkeitssuche durch.
 *
 * @param queryEmbedding - Der Embedding-Vektor der Suchanfrage
 * @param userId - Scope: User-ID
 * @param personaId - Scope: Persona-ID
 * @param workspaceId - Scope: Workspace-ID
 * @param limit - Maximale Anzahl Ergebnisse
 * @param minSimilarity - Minimale Aehnlichkeit (0..1)
 */
export async function vectorSearch(
  queryEmbedding: number[],
  userId: string,
  personaId: string,
  workspaceId: string,
  limit = 10,
  minSimilarity = 0.5,
): Promise<VectorHit[]> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return [];

  const db = getWorldModelDb();

  try {
    const embeddingJson = JSON.stringify(queryEmbedding);
    const result = await db.query<{
      target_type: string;
      target_id: string;
      text: string;
      similarity: number;
      model: string;
      model_version: string;
    }>(
      `SELECT
         e.target_type,
         e.target_id,
         e.target_content AS text,
         1 - (e.embedding <=> $1::vector) AS similarity,
         e.model,
         e.model_version
       FROM world_model_embeddings e
       WHERE e.user_id = $2
         AND e.persona_id = $3
         AND e.workspace_id = $4
         AND 1 - (e.embedding <=> $1::vector) >= $5
       ORDER BY e.embedding <=> $1::vector
       LIMIT $6`,
      [embeddingJson, userId, personaId, workspaceId, minSimilarity, limit],
    );

    return result.rows.map((row) => ({
      targetType: row.target_type,
      targetId: row.target_id,
      text: row.text,
      similarity: Number(row.similarity),
      model: row.model,
      modelVersion: row.model_version,
    }));
  } catch (error) {
    console.error('[world-model:vector] search failed:', error);
    return [];
  }
}

/**
 * Prueft, ob pgvector in der Datenbank verfuegbar ist.
 */
export async function isVectorSearchAvailable(): Promise<boolean> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return false;

  try {
    const db = getWorldModelDb();
    await db.query('SELECT 1 FROM world_model_embeddings LIMIT 0');
    return true;
  } catch {
    return false;
  }
}

/**
 * Zaehlt die Anzahl der Embeddings im Scope.
 */
export async function countEmbeddings(
  userId: string,
  personaId: string,
  workspaceId: string,
): Promise<number> {
  const config = getWorldModelConfig();
  if (!config.enabled && !config.e2eEnabled) return 0;

  try {
    const db = getWorldModelDb();
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM world_model_embeddings
       WHERE user_id = $1 AND persona_id = $2 AND workspace_id = $3`,
      [userId, personaId, workspaceId],
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
