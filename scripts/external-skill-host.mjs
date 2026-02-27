import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const WORKSPACE_ROOT = path.resolve(process.cwd());
const HANDLER_CACHE = new Map();

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(candidate, root) {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedRoot = normalizePathForCompare(root);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function resolveHandlerPath(inputPath) {
  const absolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(WORKSPACE_ROOT, inputPath);
  if (!isWithinRoot(absolutePath, WORKSPACE_ROOT)) {
    throw new Error(`External skill handler path must stay inside workspace root: ${inputPath}`);
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`External skill handler not found at: ${absolutePath}`);
  }
  return absolutePath;
}

function resolveModuleHandler(moduleValue, functionName) {
  const moduleRecord = moduleValue && typeof moduleValue === 'object' ? moduleValue : {};
  const candidates = [moduleRecord.handler, moduleRecord.execute, moduleRecord.default];

  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      if (typeof candidate.handler === 'function') return candidate.handler;
      if (typeof candidate.execute === 'function') return candidate.execute;
    }
  }

  throw new Error(
    `External skill "${functionName}" does not export a callable handler or execute function.`,
  );
}

async function loadModule(absolutePath) {
  try {
    return require(absolutePath);
  } catch (error) {
    if (!error || error.code !== 'ERR_REQUIRE_ESM') {
      throw error;
    }
    return await import(pathToFileURL(absolutePath).href);
  }
}

function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object') return undefined;

  const context = raw;
  const maybeString = (value) => (typeof value === 'string' && value.trim() ? value : undefined);

  return {
    bypassApproval: context.bypassApproval === true,
    workspaceCwd: maybeString(context.workspaceCwd),
    conversationId: maybeString(context.conversationId),
    userId: maybeString(context.userId),
    platform: maybeString(context.platform),
    externalChatId: maybeString(context.externalChatId),
  };
}

async function resolveHandler(functionName, handlerPath) {
  const absolutePath = resolveHandlerPath(String(handlerPath || '').trim());
  const stat = fs.statSync(absolutePath);
  const cacheEntry = HANDLER_CACHE.get(absolutePath);
  if (cacheEntry && cacheEntry.mtimeMs === stat.mtimeMs) {
    return cacheEntry.handler;
  }

  const moduleValue = await loadModule(absolutePath);
  const handler = resolveModuleHandler(moduleValue, functionName);
  HANDLER_CACHE.set(absolutePath, { handler, mtimeMs: stat.mtimeMs });
  return handler;
}

async function handleExecute(request) {
  const id = String(request?.id || '');
  const functionName = String(request?.functionName || '').trim();
  const handlerPath = String(request?.handlerPath || '').trim();
  const args = request?.args && typeof request.args === 'object' ? request.args : {};
  const context = sanitizeContext(request?.context);

  if (!id) return;
  if (!functionName) {
    process.send?.({ id, ok: false, error: 'Missing functionName for external skill execution.' });
    return;
  }
  if (!handlerPath) {
    process.send?.({ id, ok: false, error: 'Missing handlerPath for external skill execution.' });
    return;
  }

  try {
    const handler = await resolveHandler(functionName, handlerPath);
    const result = await handler(args, context);
    process.send?.({ id, ok: true, result });
  } catch (error) {
    process.send?.({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

process.on('message', async (message) => {
  const request = message && typeof message === 'object' ? message : {};
  if (request.type !== 'execute') {
    return;
  }
  await handleExecute(request);
});
