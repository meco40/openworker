
import { Type, FunctionDeclaration } from "@google/genai";

export const memoryStoreSpec: FunctionDeclaration = {
  name: "memory_store",
  description: "Save a new piece of information, a user preference, or a lesson learned to the agent's long-term memory graph.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { 
        type: Type.STRING, 
        enum: ["fact", "preference", "avoidance", "lesson"],
        description: "The type of memory entry."
      },
      content: { type: Type.STRING, description: "The core information to remember." },
      importance: { type: Type.NUMBER, description: "How critical this memory is (1-5)." }
    },
    required: ["type", "content"]
  }
};

export const memoryRecallSpec: FunctionDeclaration = {
  name: "memory_recall",
  description: "Search and retrieve information from the agent's long-term memory graph based on a query.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Semantic search query or topic to recall." }
    },
    required: ["query"]
  }
};
