
import { Type, FunctionDeclaration } from "@google/genai";

export const filesystemTool: FunctionDeclaration = {
  name: "file_read",
  description: "Read the content of a file in the workspace sandbox.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: "Relative path to file" }
    },
    required: ["path"]
  }
};
