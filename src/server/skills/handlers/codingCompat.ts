import fs from 'node:fs/promises';
import type { SkillDispatchContext } from '@/server/skills/types';
import { applyUpdateHunk } from '@/server/skills/handlers/applyPatchCompatUpdate';
import { ensureParentDir, resolveWorkspacePath } from '@/server/skills/handlers/workspaceFs';

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';
const DEFAULT_READ_MAX_CHARS = 200_000;
const DEFAULT_EDIT_MAX_REPLACEMENTS = 1;

type AddFileHunk = {
  kind: 'add';
  path: string;
  contents: string;
};

type DeleteFileHunk = {
  kind: 'delete';
  path: string;
};

type UpdateFileChunk = {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};

type UpdateFileHunk = {
  kind: 'update';
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
};

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export async function readCompatHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const inputPath = String(args.path || '').trim();
  if (!inputPath) {
    throw new Error('read requires path.');
  }
  const maxCharsRaw = Number(args.maxChars ?? DEFAULT_READ_MAX_CHARS);
  const maxChars = Number.isFinite(maxCharsRaw)
    ? Math.max(1_000, Math.min(1_000_000, Math.floor(maxCharsRaw)))
    : DEFAULT_READ_MAX_CHARS;

  const { resolvedPath, relativePath } = resolveWorkspacePath(inputPath, context);
  const content = await fs.readFile(resolvedPath, 'utf8');

  const fromRaw = Number(args.from ?? args.startLine ?? 1);
  const linesRaw = Number(args.lines ?? args.lineCount ?? Number.POSITIVE_INFINITY);
  const startLine = Number.isFinite(fromRaw) ? Math.max(1, Math.floor(fromRaw)) : 1;
  const lineCount = Number.isFinite(linesRaw)
    ? Math.max(1, Math.floor(linesRaw))
    : Number.POSITIVE_INFINITY;
  const split = content.split('\n');
  const endLine = Number.isFinite(lineCount)
    ? Math.min(split.length, startLine + lineCount - 1)
    : split.length;
  const selected = split.slice(startLine - 1, endLine).join('\n');

  const truncated = selected.length > maxChars;
  return {
    path: relativePath,
    resolvedPath,
    startLine,
    endLine,
    totalLines: split.length,
    truncated,
    content: truncated ? selected.slice(0, maxChars) : selected,
  };
}

export async function writeCompatHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const inputPath = String(args.path || '').trim();
  if (!inputPath) {
    throw new Error('write requires path.');
  }
  const content = String(args.content ?? args.text ?? '');
  const append = Boolean(args.append);
  const { resolvedPath, relativePath } = resolveWorkspacePath(inputPath, context);
  ensureParentDir(resolvedPath);

  if (append) {
    await fs.appendFile(resolvedPath, content, 'utf8');
  } else {
    await fs.writeFile(resolvedPath, content, 'utf8');
  }

  return {
    ok: true,
    path: relativePath,
    bytes: Buffer.byteLength(content, 'utf8'),
    mode: append ? 'append' : 'write',
  };
}

export async function editCompatHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const inputPath = String(args.path || '').trim();
  if (!inputPath) {
    throw new Error('edit requires path.');
  }

  const { resolvedPath, relativePath } = resolveWorkspacePath(inputPath, context);
  const original = await fs.readFile(resolvedPath, 'utf8');

  const oldText = String(args.oldText ?? args.old ?? args.search ?? '');
  const newText = String(args.newText ?? args.new ?? args.replace ?? '');
  const replaceAll = Boolean(args.replaceAll);

  if (oldText) {
    if (!original.includes(oldText)) {
      throw new Error('edit could not find oldText in file.');
    }

    if (replaceAll) {
      const next = original.split(oldText).join(newText);
      await fs.writeFile(resolvedPath, next, 'utf8');
      const replacementCount = original.split(oldText).length - 1;
      return {
        ok: true,
        path: relativePath,
        replacements: replacementCount,
        mode: 'text',
      };
    }

    const next = original.replace(oldText, newText);
    await fs.writeFile(resolvedPath, next, 'utf8');
    return {
      ok: true,
      path: relativePath,
      replacements: DEFAULT_EDIT_MAX_REPLACEMENTS,
      mode: 'text',
    };
  }

  const fromRaw = Number(args.from ?? args.startLine);
  const toRaw = Number(args.to ?? args.endLine);
  if (!Number.isFinite(fromRaw) || !Number.isFinite(toRaw)) {
    throw new Error('edit requires oldText/newText or from/to line range.');
  }

  const startLine = Math.max(1, Math.floor(fromRaw));
  const endLine = Math.max(startLine, Math.floor(toRaw));
  const lines = original.split('\n');
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const replacementLines = newText.split('\n');
  const next = [...before, ...replacementLines, ...after].join('\n');
  await fs.writeFile(resolvedPath, next, 'utf8');

  return {
    ok: true,
    path: relativePath,
    mode: 'line-range',
    startLine,
    endLine,
    insertedLines: replacementLines.length,
  };
}

export async function applyPatchCompatHandler(
  args: Record<string, unknown>,
  context?: SkillDispatchContext,
) {
  const input = String(args.input ?? args.patch ?? '').trim();
  if (!input) {
    throw new Error('apply_patch requires input.');
  }

  const { workspaceRoot } = resolveWorkspacePath('.', context);
  const parsed = parsePatchText(input);
  if (parsed.hunks.length === 0) {
    throw new Error('No files were modified.');
  }

  const summary = {
    added: [] as string[],
    modified: [] as string[],
    deleted: [] as string[],
  };

  for (const hunk of parsed.hunks) {
    if (hunk.kind === 'add') {
      const target = resolveWorkspacePath(hunk.path, context);
      ensureParentDir(target.resolvedPath);
      await fs.writeFile(target.resolvedPath, hunk.contents, 'utf8');
      summary.added.push(target.relativePath);
      continue;
    }

    if (hunk.kind === 'delete') {
      const target = resolveWorkspacePath(hunk.path, context);
      await fs.rm(target.resolvedPath, { force: false });
      summary.deleted.push(target.relativePath);
      continue;
    }

    const source = resolveWorkspacePath(hunk.path, context);
    const updated = await applyUpdateHunk(source.resolvedPath, hunk.chunks);
    if (hunk.movePath) {
      const moveTarget = resolveWorkspacePath(hunk.movePath, context);
      ensureParentDir(moveTarget.resolvedPath);
      await fs.writeFile(moveTarget.resolvedPath, updated, 'utf8');
      await fs.rm(source.resolvedPath, { force: false });
      summary.modified.push(moveTarget.relativePath);
    } else {
      await fs.writeFile(source.resolvedPath, updated, 'utf8');
      summary.modified.push(source.relativePath);
    }
  }

  return {
    ok: true,
    workspaceRoot,
    summary,
    text: formatPatchSummary(summary),
  };
}

function formatPatchSummary(summary: {
  added: string[];
  modified: string[];
  deleted: string[];
}): string {
  const lines = ['Success. Updated the following files:'];
  for (const file of summary.added) {
    lines.push(`A ${file}`);
  }
  for (const file of summary.modified) {
    lines.push(`M ${file}`);
  }
  for (const file of summary.deleted) {
    lines.push(`D ${file}`);
  }
  return lines.join('\n');
}

function parsePatchText(input: string): { hunks: Hunk[] } {
  const lines = input.split(/\r?\n/);
  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER) {
    throw new Error("The first line of the patch must be '*** Begin Patch'.");
  }
  if (lines[lines.length - 1]?.trim() !== END_PATCH_MARKER) {
    throw new Error("The last line of the patch must be '*** End Patch'.");
  }

  const hunks: Hunk[] = [];
  let cursor = 1;
  while (cursor < lines.length - 1) {
    const line = lines[cursor]?.trim();
    if (!line) {
      cursor += 1;
      continue;
    }

    if (line.startsWith(ADD_FILE_MARKER)) {
      const filePath = line.slice(ADD_FILE_MARKER.length);
      cursor += 1;
      const contentLines: string[] = [];
      while (cursor < lines.length - 1 && lines[cursor]?.startsWith('+')) {
        contentLines.push((lines[cursor] || '').slice(1));
        cursor += 1;
      }
      hunks.push({ kind: 'add', path: filePath, contents: `${contentLines.join('\n')}\n` });
      continue;
    }

    if (line.startsWith(DELETE_FILE_MARKER)) {
      const filePath = line.slice(DELETE_FILE_MARKER.length);
      hunks.push({ kind: 'delete', path: filePath });
      cursor += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_MARKER)) {
      const filePath = line.slice(UPDATE_FILE_MARKER.length);
      cursor += 1;
      let movePath: string | undefined;
      if ((lines[cursor] || '').trim().startsWith(MOVE_TO_MARKER)) {
        movePath = (lines[cursor] || '').trim().slice(MOVE_TO_MARKER.length);
        cursor += 1;
      }

      const chunks: UpdateFileChunk[] = [];
      while (cursor < lines.length - 1) {
        const current = lines[cursor] || '';
        const trimmed = current.trim();
        if (!trimmed) {
          cursor += 1;
          continue;
        }
        if (trimmed.startsWith('*** ')) {
          break;
        }

        let changeContext: string | undefined;
        if (current === EMPTY_CHANGE_CONTEXT_MARKER) {
          cursor += 1;
        } else if (current.startsWith(CHANGE_CONTEXT_MARKER)) {
          changeContext = current.slice(CHANGE_CONTEXT_MARKER.length);
          cursor += 1;
        }

        const chunk: UpdateFileChunk = {
          changeContext,
          oldLines: [],
          newLines: [],
          isEndOfFile: false,
        };

        while (cursor < lines.length - 1) {
          const raw = lines[cursor] || '';
          if (raw === EOF_MARKER) {
            chunk.isEndOfFile = true;
            cursor += 1;
            break;
          }
          const marker = raw[0];
          if (marker === ' ') {
            const value = raw.slice(1);
            chunk.oldLines.push(value);
            chunk.newLines.push(value);
            cursor += 1;
            continue;
          }
          if (marker === '+') {
            chunk.newLines.push(raw.slice(1));
            cursor += 1;
            continue;
          }
          if (marker === '-') {
            chunk.oldLines.push(raw.slice(1));
            cursor += 1;
            continue;
          }
          break;
        }

        if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
          throw new Error('Invalid update hunk: empty chunk.');
        }
        chunks.push(chunk);
      }

      if (chunks.length === 0) {
        throw new Error(`Invalid patch hunk for ${filePath}: update has no chunks.`);
      }
      hunks.push({
        kind: 'update',
        path: filePath,
        movePath,
        chunks,
      });
      continue;
    }

    throw new Error(`Invalid patch line: ${line}`);
  }

  return { hunks };
}
