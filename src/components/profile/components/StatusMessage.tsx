'use client';

import React from 'react';
import { STATUS_CLASS } from '@/components/profile/types';
import type { StatusMessage as StatusMessageType } from '@/components/profile/types';

interface StatusMessageProps {
  message: StatusMessageType;
}

export const StatusMessage: React.FC<StatusMessageProps> = ({ message }) => {
  return (
    <div className={`rounded-2xl border px-4 py-3 text-xs ${STATUS_CLASS[message.tone]}`}>
      {message.text}
    </div>
  );
};
