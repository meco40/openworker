import { describe, expect, it } from 'vitest';
import { ChannelType } from '../../../types';
import {
  MAX_FILE_SIZE,
  formatFileSize,
  getAttachmentIcon,
  getPlatformMeta,
  validateAttachmentFile,
} from '../../../src/modules/chat/uiUtils';

describe('chat ui utils', () => {
  it('formats bytes into human-readable units', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1572864)).toBe('1.5 MB');
  });

  it('returns unsupported-type error for invalid files', () => {
    expect(validateAttachmentFile({ type: 'application/zip', size: 1000 })).toContain(
      'nicht unterstützt',
    );
  });

  it('returns too-large error for oversize files', () => {
    expect(validateAttachmentFile({ type: 'image/png', size: MAX_FILE_SIZE + 1 })).toContain(
      'Datei zu groß',
    );
  });

  it('returns null when file is allowed', () => {
    expect(validateAttachmentFile({ type: 'image/png', size: 1024 })).toBeNull();
  });

  it('falls back to webchat meta when platform is unknown', () => {
    const fallback = getPlatformMeta(ChannelType.WEBCHAT);
    const unknown = getPlatformMeta('unknown-channel');
    expect(unknown.icon).toBe(fallback.icon);
    expect(unknown.bg).toBe(fallback.bg);
  });

  it('uses known and fallback icons for attachment previews', () => {
    expect(getAttachmentIcon('application/pdf')).toBe('📄');
    expect(getAttachmentIcon('application/octet-stream')).toBe('📎');
  });
});
