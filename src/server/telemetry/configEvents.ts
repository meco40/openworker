export interface ConfigEventPayload {
  userId?: string;
  source?: 'default' | 'file' | 'unknown';
  warningCount?: number;
  status?: number;
  reason?: string;
  revision?: string;
}

function emit(level: 'info' | 'warn' | 'error', event: string, payload: ConfigEventPayload): void {
  const message = {
    category: 'config',
    event,
    ...payload,
    at: new Date().toISOString(),
  };

  if (level === 'warn') {
    console.warn(message);
    return;
  }
  if (level === 'error') {
    console.error(message);
    return;
  }
  console.info(message);
}

export function logConfigLoadSuccess(payload: ConfigEventPayload): void {
  emit('info', 'config.load.success', payload);
}

export function logConfigLoadFailed(payload: ConfigEventPayload): void {
  emit('error', 'config.load.failed', payload);
}

export function logConfigSaveAttempt(payload: ConfigEventPayload): void {
  emit('info', 'config.save.attempt', payload);
}

export function logConfigSaveSuccess(payload: ConfigEventPayload): void {
  emit('info', 'config.save.success', payload);
}

export function logConfigSaveFailed(payload: ConfigEventPayload): void {
  emit('warn', 'config.save.failed', payload);
}
