import { runAttachmentConsistencyAudit } from '@/server/channels/messages/attachmentConsistency';
import { log } from '@/logging/logService';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

let monitorTimer: NodeJS.Timeout | null = null;
let lastMissingCount = 0;
let lastBucketMismatchCount = 0;
let lastFailureFingerprint = '';

export interface AttachmentHealthSnapshot {
  missingFiles: number;
  bucketMismatches: number;
}

export function startAttachmentHealthMonitor(): void {
  if (monitorTimer) return;

  const intervalMs = resolveIntervalMs();
  runMonitorCycle();
  monitorTimer = setInterval(runMonitorCycle, intervalMs);
}

export function stopAttachmentHealthMonitorForTests(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  lastMissingCount = 0;
  lastBucketMismatchCount = 0;
  lastFailureFingerprint = '';
}

export function evaluateAttachmentHealthSnapshot(
  snapshot: AttachmentHealthSnapshot,
  previous: AttachmentHealthSnapshot = {
    missingFiles: lastMissingCount,
    bucketMismatches: lastBucketMismatchCount,
  },
): Array<{ level: 'info' | 'warn'; message: string; metadata: Record<string, unknown> }> {
  const entries: Array<{
    level: 'info' | 'warn';
    message: string;
    metadata: Record<string, unknown>;
  }> = [];
  const hasIssues = snapshot.missingFiles > 0 || snapshot.bucketMismatches > 0;
  if (hasIssues) {
    entries.push({
      level: 'warn',
      message: 'attachments.consistency.alert',
      metadata: {
        missingFiles: snapshot.missingFiles,
        bucketMismatches: snapshot.bucketMismatches,
      },
    });
  } else if (previous.missingFiles > 0 || previous.bucketMismatches > 0) {
    entries.push({
      level: 'info',
      message: 'attachments.consistency.recovered',
      metadata: {
        previousMissingFiles: previous.missingFiles,
        previousBucketMismatches: previous.bucketMismatches,
      },
    });
  }
  return entries;
}

function runMonitorCycle(): void {
  try {
    const report = runAttachmentConsistencyAudit();
    const entries = evaluateAttachmentHealthSnapshot({
      missingFiles: report.missingFiles,
      bucketMismatches: report.bucketMismatches,
    });
    for (const entry of entries) {
      log(entry.level, 'SYS', entry.message, {
        ...entry.metadata,
        scannedMessages: report.scannedMessages,
        scannedAttachments: report.scannedAttachments,
      });
    }
    lastMissingCount = report.missingFiles;
    lastBucketMismatchCount = report.bucketMismatches;
    lastFailureFingerprint = '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fingerprint = `monitor:${message}`;
    if (fingerprint !== lastFailureFingerprint) {
      log('error', 'SYS', 'attachments.consistency.monitor_failed', { message });
      lastFailureFingerprint = fingerprint;
    }
  }
}

function resolveIntervalMs(): number {
  const raw = Number.parseInt(
    String(process.env.ATTACHMENT_CONSISTENCY_CHECK_INTERVAL_MS || ''),
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, raw);
}
