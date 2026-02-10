export type ChannelName = 'WebChat' | 'Discord' | 'Telegram' | 'WhatsApp';

export interface BaseEntity {
  id: string;
  createdAt: string;
}
