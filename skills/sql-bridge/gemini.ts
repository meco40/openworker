
import { Type, FunctionDeclaration } from "@google/genai";

export const geminiSpec: FunctionDeclaration = {
  name: "db_query",
  description: "Execute a read-only SQL query against the connected database.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Valid SQL SELECT statement." }
    },
    required: ["query"]
  }
};
