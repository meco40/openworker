// ─── Persona Integration ─────────────────────────────────────
// Loads and applies persona configuration (SOUL, IDENTITY, TOOLS)
// to worker task execution.

import { getPersonaRepository } from '../personas/personaRepository';
import type { PersonaFileName } from '../personas/personaTypes';

// ─── Types ───────────────────────────────────────────────────

export interface PersonaContext {
  systemInstruction: string | null;
  name: string | null;
  emoji: string | null;
  vibe: string | null;
  allowedTools: string[] | null; // null = all tools allowed
}

// ─── TOOLS.md Parser ─────────────────────────────────────────

/**
 * Parses TOOLS.md content to extract allowed tool names.
 * 
 * Format:
 * - Lines starting with "-" or "*" are tool names
 * - "# all" or "# default" means all tools are allowed
 * - Empty lines and comments (starting with #) are ignored
 * 
 * Example:
 * ```
 * # Allowed tools for this persona
 * - file_read
 * - write_file
 * - browser_fetch
 * ```
 */
export function parseToolsMd(content: string): string[] | null {
  if (!content || !content.trim()) {
    return null; // No restrictions - all tools allowed
  }

  const lines = content.split('\n');
  const allowedTools: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines
    if (!trimmed) continue;
    
    // Skip comments (unless it's a special directive)
    if (trimmed.startsWith('#')) {
      const directive = trimmed.slice(1).trim().toLowerCase();
      if (directive === 'all' || directive === 'default') {
        return null; // All tools allowed
      }
      continue;
    }

    // Extract tool name from list items
    let toolName = trimmed;
    if (toolName.startsWith('-') || toolName.startsWith('*')) {
      toolName = toolName.slice(1).trim();
    }

    // Remove inline comments
    const commentIndex = toolName.indexOf('#');
    if (commentIndex !== -1) {
      toolName = toolName.slice(0, commentIndex).trim();
    }

    if (toolName) {
      allowedTools.push(toolName);
    }
  }

  return allowedTools.length > 0 ? allowedTools : null;
}

// ─── Persona Loader ──────────────────────────────────────────

/**
 * Loads persona context for a task.
 * Returns null context if no persona is assigned or persona not found.
 */
export async function loadPersonaContext(
  personaId: string | null | undefined,
): Promise<PersonaContext> {
  if (!personaId) {
    return {
      systemInstruction: null,
      name: null,
      emoji: null,
      vibe: null,
      allowedTools: null,
    };
  }

  const repo = getPersonaRepository();
  const persona = repo.getPersonaWithFiles(personaId);

  if (!persona) {
    console.warn(`[Worker] Assigned persona ${personaId} not found`);
    return {
      systemInstruction: null,
      name: null,
      emoji: null,
      vibe: null,
      allowedTools: null,
    };
  }

  // Get system instruction from SOUL.md + AGENTS.md + USER.md
  const systemInstruction = repo.getPersonaSystemInstruction(personaId);

  // Parse TOOLS.md for allowed tools
  const toolsContent = persona.files['TOOLS.md'] || '';
  const allowedTools = parseToolsMd(toolsContent);

  return {
    systemInstruction,
    name: persona.name,
    emoji: persona.emoji,
    vibe: persona.vibe,
    allowedTools,
  };
}

// ─── Prompt Builder ──────────────────────────────────────────

/**
 * Builds the executor system prompt with persona context.
 */
export function buildPersonaSystemPrompt(
  basePrompt: string,
  personaContext: PersonaContext,
  taskContext: {
    title: string;
    objective: string;
    workspaceType: string;
    step: string;
  },
): string {
  let prompt = basePrompt
    .replace('{title}', taskContext.title)
    .replace('{objective}', taskContext.objective)
    .replace('{workspaceType}', taskContext.workspaceType)
    .replace('{step}', taskContext.step);

  // Add persona identity if available
  if (personaContext.name) {
    prompt += `\n\n---\n\n`;
    prompt += `**Persona:** ${personaContext.emoji || '🤖'} ${personaContext.name}\n`;
    if (personaContext.vibe) {
      prompt += `**Stil:** ${personaContext.vibe}\n`;
    }
  }

  // Add persona system instruction if available
  if (personaContext.systemInstruction) {
    prompt += `\n---\n\n${personaContext.systemInstruction}`;
  }

  return prompt;
}

// ─── Tool Filter ─────────────────────────────────────────────

/**
 * Filters tools based on persona's TOOLS.md configuration.
 */
export function filterToolsByPersona<T extends { function: { name: string } }>(
  tools: T[],
  allowedTools: string[] | null,
): T[] {
  if (!allowedTools || allowedTools.length === 0) {
    return tools; // No restrictions
  }

  const allowedSet = new Set(allowedTools);
  return tools.filter((tool) => allowedSet.has(tool.function.name));
}

/**
 * Checks if a specific tool is allowed for the persona.
 */
export function isToolAllowed(toolName: string, allowedTools: string[] | null): boolean {
  if (!allowedTools || allowedTools.length === 0) {
    return true; // All tools allowed
  }
  return allowedTools.includes(toolName);
}
