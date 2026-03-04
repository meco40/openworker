interface GuardProjectSuggestion {
  name: string;
  slug: string;
}

const BUILD_VERB_RE =
  /\b(erstelle|bau|baue|implementiere|entwickle|programmiere|schreibe|fixe|repariere|refactor|refaktoriere|build|create|implement|develop|code|write|fix|refactor)\b/i;
const CODE_TARGET_RE =
  /\b(webapp|web-app|app|website|frontend|backend|fullstack|next\.?js|react|node\.?js|api|repo|repository|projekt|project|feature|funktion|component|komponente|datenbank|database|migration|test|tests|bug)\b/i;
const DIRECT_ENGINEERING_CUE_RE =
  /\b(next\.?js|react|typescript|javascript|python|docker|git|pull request|commit|branch|worktree|npm|pnpm|yarn)\b/i;

export function isProjectRequiredIntent(content: string): boolean {
  const normalized = String(content || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('/')) return false;

  const hasBuildVerb = BUILD_VERB_RE.test(normalized);
  const hasCodeTarget = CODE_TARGET_RE.test(normalized);
  if (hasBuildVerb && hasCodeTarget) return true;

  if (DIRECT_ENGINEERING_CUE_RE.test(normalized) && hasBuildVerb) return true;
  return false;
}

function sanitizeProjectName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .slice(0, 80);
}

export function resolveProjectNameFromClarificationReply(params: {
  reply: string;
  originalTask: string;
}): string | null {
  const reply = sanitizeProjectName(params.reply);
  if (!reply) return null;

  const autoReplyRe = /^(auto|egal|ja|yes|ok|okay|weiter|mach|go)$/i;
  if (autoReplyRe.test(reply)) {
    const fallback = sanitizeProjectName(params.originalTask);
    return fallback || 'Project';
  }

  return reply;
}

export function buildProjectClarificationPrompt(params: {
  projects?: GuardProjectSuggestion[];
}): string {
  const lines: string[] = [
    'Build/Code-Intent erkannt, aber es ist kein aktives Projekt gesetzt.',
    '',
    'Nenne bitte jetzt den Projektnamen (eine Antwort reicht).',
    'Beispiel: `Notes`',
    '',
    'Danach erstelle ich das Projekt automatisch und setze die Aufgabe direkt end-to-end um.',
    'Optional kannst du auch `auto` schreiben.',
  ];

  const projects = (params.projects || []).slice(0, 5);
  if (projects.length > 0) {
    lines.push('');
    lines.push('Vorhandene Projekte:');
    for (const project of projects) {
      lines.push(`- ${project.name} (${project.slug})`);
    }
    lines.push('');
    lines.push(
      'Falls du eines davon nutzen willst, antworte mit dem genauen Namen oder nutze `/project use <id|slug|index>`.',
    );
  }

  return lines.join('\n');
}
