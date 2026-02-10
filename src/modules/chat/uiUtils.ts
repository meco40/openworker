import { ChannelType } from '../../../types';

export interface PlatformMeta {
  color: string;
  icon: string;
  bg: string;
  text: string;
  border: string;
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

const PLATFORM_META_BY_CHANNEL: Record<string, PlatformMeta> = {
  [ChannelType.WHATSAPP]: {
    color: 'emerald',
    icon: '💬',
    bg: 'bg-emerald-600',
    text: 'text-emerald-500',
    border: 'border-emerald-500/20',
  },
  [ChannelType.TELEGRAM]: {
    color: 'blue',
    icon: '✈️',
    bg: 'bg-blue-600',
    text: 'text-blue-500',
    border: 'border-blue-500/20',
  },
  [ChannelType.DISCORD]: {
    color: 'indigo',
    icon: '👾',
    bg: 'bg-indigo-600',
    text: 'text-indigo-500',
    border: 'border-indigo-500/20',
  },
  [ChannelType.IMESSAGE]: {
    color: 'sky',
    icon: '☁️',
    bg: 'bg-sky-600',
    text: 'text-sky-500',
    border: 'border-sky-500/20',
  },
  [ChannelType.WEBCHAT]: {
    color: 'zinc',
    icon: '🏠',
    bg: 'bg-zinc-700',
    text: 'text-zinc-400',
    border: 'border-zinc-700/20',
  },
};

const ATTACHMENT_ICON_BY_TYPE: Record<string, string> = {
  'application/pdf': '📄',
  'text/plain': '📝',
  'text/csv': '📊',
  'text/markdown': '📋',
  'application/json': '🔧',
};

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getPlatformMeta(channelType: string): PlatformMeta {
  return PLATFORM_META_BY_CHANNEL[channelType] ?? PLATFORM_META_BY_CHANNEL[ChannelType.WEBCHAT];
}

export function getAttachmentIcon(type: string): string {
  return ATTACHMENT_ICON_BY_TYPE[type] ?? '📎';
}

export function validateAttachmentFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type as (typeof ALLOWED_ATTACHMENT_TYPES)[number])) {
    return `Dateityp "${file.type || 'unbekannt'}" wird nicht unterstützt.`;
  }

  if (file.size > MAX_FILE_SIZE) {
    return `Datei zu groß (max. ${formatFileSize(MAX_FILE_SIZE)}).`;
  }

  return null;
}
