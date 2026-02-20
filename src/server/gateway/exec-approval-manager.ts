import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  commandFingerprint,
  evaluateNodeCommandPolicy,
  normalizeCommand,
} from './node-command-policy';

interface ApprovalStoreRecord {
  fingerprint: string;
  command: string;
  updatedAt: string;
}

interface ApprovalStore {
  version: 1;
  approvals: ApprovalStoreRecord[];
}

export interface ApprovalStoreOptions {
  storePath?: string;
}

const STORE_VERSION = 1;

function resolveApprovalStorePath(storePath?: string): string {
  if (storePath?.trim()) {
    return path.resolve(storePath);
  }
  return path.resolve(process.cwd(), '.local', 'exec-approvals.json');
}

function ensureStoreDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadStore(filePath: string): ApprovalStore {
  if (!fs.existsSync(filePath)) {
    return { version: STORE_VERSION, approvals: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ApprovalStore>;
    if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.approvals)) {
      return { version: STORE_VERSION, approvals: [] };
    }
    return {
      version: STORE_VERSION,
      approvals: parsed.approvals
        .filter(
          (record): record is ApprovalStoreRecord =>
            typeof record?.fingerprint === 'string' &&
            typeof record?.command === 'string' &&
            typeof record?.updatedAt === 'string',
        )
        .map((record) => ({
          fingerprint: record.fingerprint,
          command: normalizeCommand(record.command),
          updatedAt: record.updatedAt,
        })),
    };
  } catch {
    return { version: STORE_VERSION, approvals: [] };
  }
}

function saveStore(filePath: string, store: ApprovalStore): void {
  ensureStoreDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

export function listApprovedCommands(options: ApprovalStoreOptions = {}): ApprovalStoreRecord[] {
  const filePath = resolveApprovalStorePath(options.storePath);
  const store = loadStore(filePath);
  return [...store.approvals].sort((a, b) => a.command.localeCompare(b.command));
}

export function clearApprovedCommands(options: ApprovalStoreOptions = {}): void {
  const filePath = resolveApprovalStorePath(options.storePath);
  saveStore(filePath, { version: STORE_VERSION, approvals: [] });
}

export function approveCommand(command: string, options: ApprovalStoreOptions = {}): void {
  const policy = evaluateNodeCommandPolicy(command);
  if (!policy.allowed) {
    throw new Error(policy.reason || 'Command blocked by security policy.');
  }

  const filePath = resolveApprovalStorePath(options.storePath);
  const store = loadStore(filePath);
  const fingerprint = commandFingerprint(command);
  const normalized = normalizeCommand(command);
  const next: ApprovalStoreRecord = {
    fingerprint,
    command: normalized,
    updatedAt: new Date().toISOString(),
  };

  const index = store.approvals.findIndex((entry) => entry.fingerprint === fingerprint);
  if (index >= 0) {
    store.approvals[index] = next;
  } else {
    store.approvals.push(next);
  }
  saveStore(filePath, store);
}

export function revokeCommand(command: string, options: ApprovalStoreOptions = {}): boolean {
  const filePath = resolveApprovalStorePath(options.storePath);
  const store = loadStore(filePath);
  const fingerprint = commandFingerprint(command);
  const initialLength = store.approvals.length;
  store.approvals = store.approvals.filter((entry) => entry.fingerprint !== fingerprint);
  if (store.approvals.length === initialLength) {
    return false;
  }
  saveStore(filePath, store);
  return true;
}

export function isCommandApproved(command: string, options: ApprovalStoreOptions = {}): boolean {
  const filePath = resolveApprovalStorePath(options.storePath);
  const store = loadStore(filePath);
  const fingerprint = commandFingerprint(command);
  return store.approvals.some((entry) => entry.fingerprint === fingerprint);
}

export async function promptCommandApproval(
  command: string,
): Promise<{ approved: boolean; remember: boolean }> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question(
        `Approve command?\n  ${normalizeCommand(command)}\n[y]es / [a]lways / [n]o: `,
      )
    )
      .trim()
      .toLowerCase();

    if (answer === 'y' || answer === 'yes') {
      return { approved: true, remember: false };
    }
    if (answer === 'a' || answer === 'always') {
      return { approved: true, remember: true };
    }
    return { approved: false, remember: false };
  } finally {
    rl.close();
  }
}
