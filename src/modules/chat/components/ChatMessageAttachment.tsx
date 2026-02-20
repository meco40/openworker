import React from 'react';
import type { MessageAttachment } from '@/shared/domain/types';
import { formatFileSize, getAttachmentIcon } from '@/modules/chat/uiUtils';

interface ChatMessageAttachmentProps {
  attachment: MessageAttachment;
}

const ChatMessageAttachment: React.FC<ChatMessageAttachmentProps> = ({ attachment }) => {
  if (attachment.type.startsWith('image/')) {
    return (
      <div className="mt-2 max-w-xs overflow-hidden rounded-lg border border-zinc-700/50">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.url}
          alt={attachment.name}
          className="max-h-60 max-w-full bg-zinc-950 object-contain"
        />
        <div className="flex items-center justify-between bg-zinc-900/80 px-2 py-1">
          <span className="truncate text-[10px] text-zinc-500">{attachment.name}</span>
          <span className="ml-2 shrink-0 text-[9px] text-zinc-600">
            {formatFileSize(attachment.size)}
          </span>
        </div>
      </div>
    );
  }

  const icon = getAttachmentIcon(attachment.type);
  return (
    <div className="mt-2 flex max-w-xs items-center space-x-2 rounded-lg border border-zinc-700/40 bg-zinc-900/60 px-3 py-2">
      <span className="text-lg">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-300">{attachment.name}</div>
        <div className="text-[10px] text-zinc-600">{formatFileSize(attachment.size)}</div>
      </div>
    </div>
  );
};

export default ChatMessageAttachment;
