import React from 'react';
import type { MessageAttachment } from '../../../../types';
import { formatFileSize, getAttachmentIcon } from '../uiUtils';

interface ChatMessageAttachmentProps {
  attachment: MessageAttachment;
}

const ChatMessageAttachment: React.FC<ChatMessageAttachmentProps> = ({ attachment }) => {
  if (attachment.type.startsWith('image/')) {
    return (
      <div className="mt-2 rounded-lg overflow-hidden border border-zinc-700/50 max-w-xs">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={attachment.url}
          alt={attachment.name}
          className="max-w-full max-h-60 object-contain bg-zinc-950"
        />
        <div className="px-2 py-1 bg-zinc-900/80 flex items-center justify-between">
          <span className="text-[10px] text-zinc-500 truncate">{attachment.name}</span>
          <span className="text-[9px] text-zinc-600 ml-2 shrink-0">
            {formatFileSize(attachment.size)}
          </span>
        </div>
      </div>
    );
  }

  const icon = getAttachmentIcon(attachment.type);
  return (
    <div className="mt-2 flex items-center space-x-2 bg-zinc-900/60 border border-zinc-700/40 rounded-lg px-3 py-2 max-w-xs">
      <span className="text-lg">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-zinc-300 font-medium truncate">{attachment.name}</div>
        <div className="text-[10px] text-zinc-600">{formatFileSize(attachment.size)}</div>
      </div>
    </div>
  );
};

export default ChatMessageAttachment;
