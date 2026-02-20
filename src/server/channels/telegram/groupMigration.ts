import { migrateTelegramPairedChatId } from '../pairing/telegramCodePairing';

export interface TelegramGroupMigrationMessage {
  chat: { id: number };
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export interface TelegramGroupMigrationResult {
  migrated: boolean;
  oldChatId?: string;
  newChatId?: string;
}

export function resolveTelegramGroupMigration(
  message: TelegramGroupMigrationMessage,
): { oldChatId: string; newChatId: string } | null {
  if (typeof message.migrate_to_chat_id === 'number') {
    return {
      oldChatId: String(message.chat.id),
      newChatId: String(message.migrate_to_chat_id),
    };
  }

  if (typeof message.migrate_from_chat_id === 'number') {
    return {
      oldChatId: String(message.migrate_from_chat_id),
      newChatId: String(message.chat.id),
    };
  }

  return null;
}

export function applyTelegramGroupMigration(
  message: TelegramGroupMigrationMessage,
): TelegramGroupMigrationResult {
  const migration = resolveTelegramGroupMigration(message);
  if (!migration) {
    return { migrated: false };
  }

  const migrated = migrateTelegramPairedChatId(migration.oldChatId, migration.newChatId);
  return {
    migrated,
    oldChatId: migration.oldChatId,
    newChatId: migration.newChatId,
  };
}
