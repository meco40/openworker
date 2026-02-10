
import { Type, FunctionDeclaration } from "@google/genai";

export const geminiSpec: FunctionDeclaration = {
  name: "shell_execute",
  description: "Execute a bash command in the isolated workspace terminal.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: { type: Type.STRING, description: "The shell command to run (e.g., 'ls -la')." }
    },
    required: ["command"]
  }
};
