'use client';

import React from 'react';
import { STATUS_CLASS } from '@/components/config/types';
import type { StatusMessage as StatusMessageType } from '@/components/config/types';

interface StatusMessageProps {
  message: StatusMessageType;
}

export const StatusMessage: React.FC<StatusMessageProps> = ({ message }) => {
  return (
    <div className={`rounded-lg border px-4 py-3 text-xs ${STATUS_CLASS[message.tone]}`}>
      {message.text}
    </div>
  );
};
