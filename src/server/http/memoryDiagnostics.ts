const TRUTHY_MEMORY_DIAGNOSTICS = new Set(['1', 'true', 'on', 'yes']);

export function parseMemoryDiagnosticsEnabled(request: Request): boolean {
  const raw = new URL(request.url).searchParams.get('memoryDiagnostics');
  if (!raw) return false;
  return TRUTHY_MEMORY_DIAGNOSTICS.has(raw.trim().toLowerCase());
}
