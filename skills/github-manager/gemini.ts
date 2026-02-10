
import { Type, FunctionDeclaration } from "@google/genai";

export const geminiSpec: FunctionDeclaration = {
  name: "github_query",
  description: "Interact with GitHub repositories to manage code, issues, and PRs.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      repo: { type: Type.STRING, description: "Target repository (e.g., 'facebook/react')" },
      action: { 
        type: Type.STRING, 
        description: "Action to perform",
        enum: ["list_issues", "list_pulls", "repo_info", "search_code"]
      },
      query: { type: Type.STRING, description: "Search query if applicable" }
    },
    required: ["repo", "action"]
  }
};
