
import { ai } from "../../services/gemini";

export const getEmbedding = async (text: string): Promise<number[]> => {
  try {
    /**
     * The error 'Value must be a list given an array path requests[]' often occurs 
     * when the backend misinterprets a single embedding request as a batch one.
     * We attempt the single 'embedContent' call first with the standard SDK structure.
     */
    const result = await ai.models.embedContent({
      model: "text-embedding-004",
      content: { parts: [{ text }] }
    });
    
    if (result?.embedding?.values) {
      return result.embedding.values;
    }

    throw new Error("Invalid response format from embedContent");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Primary embedding attempt failed, trying batch fallback:", message);

    /**
     * If the single call fails with a batch-related error, 
     * we try the explicit batch method if available.
     */
    try {
      const batchResult = await ai.models.batchEmbedContents({
        requests: [{
          model: "text-embedding-004",
          content: { parts: [{ text }] }
        }]
      });
      
      if (batchResult?.embeddings?.[0]?.values) {
        return batchResult.embeddings[0].values;
      }
    } catch (batchError) {
      console.error("Batch embedding fallback also failed:", batchError);
    }

    // Return a zero-vector (768 dimensions for text-embedding-004) 
    // to ensure the application remains stable.
    return new Array(768).fill(0);
  }
};

export const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let mA = 0;
  let mB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    mA += vecA[i] * vecA[i];
    mB += vecB[i] * vecB[i];
  }
  mA = Math.sqrt(mA);
  mB = Math.sqrt(mB);
  if (mA === 0 || mB === 0) return 0;
  return dotProduct / (mA * mB);
};
