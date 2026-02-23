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

export function buildProjectGuardPrompt(params: {
  approvalToken: string;
  projects?: GuardProjectSuggestion[];
}): string {
  const lines: string[] = [
    'Fuer diese Anfrage erkenne ich Build/Code-Intent, aber es ist kein aktives Projekt gesetzt.',
    '',
    'Bitte waehle einen sicheren Ausfuehrungspfad:',
    '- `/project new <name>` fuer ein neues Projekt-Workspace',
    '- `/project use <id|slug>` fuer ein bestehendes Projekt',
  ];

  const projects = (params.projects || []).slice(0, 5);
  if (projects.length > 0) {
    lines.push('');
    lines.push('Vorhandene Projekte:');
    for (const project of projects) {
      lines.push(`- ${project.name} (${project.slug})`);
    }
  }

  lines.push('');
  lines.push(`Alternativ einmalig bestaetigen: \`/approve ${params.approvalToken}\``);
  lines.push(`Oder ablehnen: \`/deny ${params.approvalToken}\``);
  return lines.join('\n');
}
