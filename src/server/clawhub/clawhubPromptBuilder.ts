import fs from 'node:fs';
import path from 'node:path';

import type { ClawHubRepository } from '@/server/clawhub/clawhubRepository';

interface PromptBuilderOptions {
  workspaceDir: string;
  repository: ClawHubRepository;
  maxSkills?: number;
  maxCharsPerSkill?: number;
  maxTotalChars?: number;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) {
    return content;
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    return content;
  }
  return content.slice(end + 4).trim();
}

function readDescriptionFromFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) {
    return '';
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    return '';
  }
  const frontmatter = content.slice(4, end);
  const match = /(?:^|\n)description:\s*(.+)/i.exec(frontmatter);
  return match?.[1]?.trim() || '';
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export async function buildClawHubPromptBlock(options: PromptBuilderOptions): Promise<string> {
  const maxSkills = options.maxSkills ?? 6;
  const maxCharsPerSkill = options.maxCharsPerSkill ?? 320;
  const maxTotalChars = options.maxTotalChars ?? 1600;

  const enabledSkills = options.repository
    .listEnabledSkills()
    .filter((skill) => skill.status === 'installed')
    .slice(0, maxSkills);

  if (enabledSkills.length === 0) {
    return '';
  }

  const lines: string[] = [
    'ClawHub Skill Context (advisory; core system and safety instructions always take precedence):',
  ];

  for (const skill of enabledSkills) {
    const skillPath = path.join(options.workspaceDir, skill.localPath, 'SKILL.md');
    const markdown = safeReadFile(skillPath);
    if (!markdown) {
      continue;
    }

    const frontmatterDescription = readDescriptionFromFrontmatter(markdown);
    const body = compactWhitespace(stripFrontmatter(markdown));
    const excerpt = body.slice(0, maxCharsPerSkill);
    const description = compactWhitespace(frontmatterDescription || skill.title || skill.slug);

    lines.push(`- ${skill.slug}: ${description}`);
    if (excerpt) {
      lines.push(`  Guidance: ${excerpt}`);
    }
  }

  if (lines.length === 1) {
    return '';
  }

  const block = lines.join('\n');
  return block.length > maxTotalChars ? `${block.slice(0, maxTotalChars - 1)}…` : block;
}
