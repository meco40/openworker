import { spawnSync } from 'node:child_process';

const MODE = process.argv[2] || 'analyze';
const MAX_FILES = Number(process.env.CLEANUP_MAX_FILES || 25);
const MAX_CHANGED_LINES = Number(process.env.CLEANUP_MAX_CHANGED_LINES || 300);
const FORBIDDEN_PREFIXES = [
  'app/api/',
  'src/server/',
  'src/lib/db/migrations.ts',
  'docs/contracts/',
];

function exec(command, args) {
  const child = spawnSync(command, args, {
    stdio: 'pipe',
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (typeof child.status !== 'number' || child.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n${child.stderr || child.stdout}`,
    );
  }
  return String(child.stdout || '');
}

function listAllowedFiles() {
  const output = exec('git', ['ls-files', 'docs', '.github']);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => file.endsWith('.md') || file.endsWith('.yml') || file.endsWith('.yaml'))
    .filter((file) => !file.startsWith('docs/contracts/'))
    .filter(
      (file) => !FORBIDDEN_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix)),
    );
}

function parseNumstat() {
  const output = exec('git', ['diff', '--numstat']);
  let changedLines = 0;
  const files = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, file] = line.split('\t');
    const added = Number.parseInt(addedRaw, 10);
    const deleted = Number.parseInt(deletedRaw, 10);
    if (Number.isFinite(added)) changedLines += added;
    if (Number.isFinite(deleted)) changedLines += deleted;
    if (file) files.push(file.trim());
  }
  return { files, changedLines };
}

function validateGuardrails() {
  const { files, changedLines } = parseNumstat();
  if (files.length > MAX_FILES) {
    throw new Error(`Guardrail exceeded: changed files ${files.length} > ${MAX_FILES}`);
  }
  if (changedLines > MAX_CHANGED_LINES) {
    throw new Error(`Guardrail exceeded: changed lines ${changedLines} > ${MAX_CHANGED_LINES}`);
  }
  const forbidden = files.filter((file) =>
    FORBIDDEN_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Forbidden paths detected in cleanup changes: ${forbidden.join(', ')}`);
  }
}

function main() {
  const allowedFiles = listAllowedFiles();
  if (allowedFiles.length === 0) {
    console.log('[cleanup-low-risk] No allowlisted files found.');
    return;
  }

  if (MODE === 'analyze') {
    const check = spawnSync('pnpm', ['exec', 'prettier', '--check', ...allowedFiles], {
      stdio: 'pipe',
      shell: process.platform === 'win32',
      encoding: 'utf8',
    });
    const requiresChanges = check.status !== 0;
    console.log(
      JSON.stringify(
        {
          mode: 'analyze',
          allowlistedFiles: allowedFiles.length,
          requiresChanges,
          maxFiles: MAX_FILES,
          maxChangedLines: MAX_CHANGED_LINES,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (MODE === 'apply') {
    exec('pnpm', ['exec', 'prettier', '--write', ...allowedFiles]);
    validateGuardrails();
    const { files, changedLines } = parseNumstat();
    console.log(
      JSON.stringify(
        {
          mode: 'apply',
          changedFiles: files.length,
          changedLines,
          files,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error(`Unknown mode: ${MODE}`);
}

try {
  main();
} catch (error) {
  console.error(
    '[cleanup-low-risk] failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}
