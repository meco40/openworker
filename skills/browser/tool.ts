
import { Type, FunctionDeclaration } from "@google/genai";

export const browserTool: FunctionDeclaration = {
  name: "browser_snapshot",
  description: "Fetch and inspect a web page to return title, metadata and excerpt.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: { type: Type.STRING, description: "Target URL to inspect." },
      format: { type: Type.STRING, description: "png or jpeg" },
      quality: { type: Type.NUMBER, description: "0-100" }
    },
    required: ["url"]
  }
};
