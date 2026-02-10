
import { Type, FunctionDeclaration } from "@google/genai";

export const geminiSpec: FunctionDeclaration = {
  name: "file_read",
  description: "Read the content of a file in the workspace sandbox safely.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: "Relative path to the file within the sandbox." }
    },
    required: ["path"]
  }
};
