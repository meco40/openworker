
import { Skill } from "../types";
import browser from "./browser";
import python from "./python-runtime";
import search from "./search";
import vision from "./vision";
import filesystem from "./filesystem";
import github from "./github-manager";
import shell from "./shell-access";
import sql from "./sql-bridge";

/**
 * Universal Tool Mapper for optional skills.
 */
export const mapSkillsToTools = (skills: Skill[], provider: 'gemini' | 'claude' = 'gemini'): any[] => {
  const tools: any[] = [];
  const installedIds = skills.filter(s => s.installed).map(s => s.id);

  const addIfInstalled = (skillId: string, skillModule: any) => {
    if (installedIds.includes(skillId)) {
      if (skillModule.providers[provider]) {
        if (skillId === 'search') {
          tools.push(skillModule.providers[provider]);
        } else {
          tools.push({ functionDeclarations: [skillModule.providers[provider]] });
        }
      }
    }
  };

  addIfInstalled('browser', browser);
  addIfInstalled('python-runtime', python);
  addIfInstalled('search', search);
  addIfInstalled('vision', vision);
  addIfInstalled('filesystem', filesystem);
  addIfInstalled('github-manager', github);
  addIfInstalled('shell-access', shell);
  addIfInstalled('sql-bridge', sql);

  return tools;
};
