
import { Type, FunctionDeclaration } from "@google/genai";

export const geminiSpec: FunctionDeclaration = {
  name: "python_execute",
  description: "Execute Python code in a safe REPL environment for calculations or data analysis.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      code: { type: Type.STRING, description: "The Python source code to execute." }
    },
    required: ["code"]
  }
};
