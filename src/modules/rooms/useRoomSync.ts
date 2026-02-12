'use client';

import { useEffect, useMemo, useState } from 'react';
import { useGatewayConnection, useGatewayEvent } from '../gateway/useGatewayConnection';
import type {
  RoomInterventionEvent,
  RoomMemberStatus,
  RoomMessage,
  RoomMetricsEvent,
  RoomRunStatusEvent,
} from './types';

export function useRoomSync(roomId: string | null, initialMessages: RoomMessage[]) {
  useGatewayConnection();

  const [messages, setMessages] = useState<RoomMessage[]>(initialMessages);
  const [memberStatus, setMemberStatus] = useState<Record<string, RoomMemberStatus>>({});
  const [runStatus, setRunStatus] = useState<RoomRunStatusEvent | null>(null);
  const [interventions, setInterventions] = useState<RoomInterventionEvent[]>([]);
  const [metrics, setMetrics] = useState<RoomMetricsEvent | null>(null);

  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  useEffect(() => {
    if (!roomId) {
      setMemberStatus({});
      setRunStatus(null);
      setInterventions([]);
      setMetrics(null);
    }
  }, [roomId]);

  useGatewayEvent<RoomMessage>('room.message', (payload) => {
    if (!roomId || payload.roomId !== roomId) {
      return;
    }

    setMessages((prev) => {
      if (prev.some((item) => item.id === payload.id || item.seq === payload.seq)) {
        return prev;
      }
      return [...prev, payload].sort((a, b) => a.seq - b.seq);
    });
  });

  useGatewayEvent<RoomMemberStatus>('room.member.status', (payload) => {
    if (!roomId || payload.roomId !== roomId) {
      return;
    }

    setMemberStatus((prev) => ({
      ...prev,
      [payload.personaId]: payload,
    }));
  });

  useGatewayEvent<RoomRunStatusEvent>('room.run.status', (payload) => {
    if (!roomId || payload.roomId !== roomId) {
      return;
    }
    setRunStatus(payload);
  });

  useGatewayEvent<RoomInterventionEvent>('room.intervention', (payload) => {
    if (!roomId || payload.roomId !== roomId) {
      return;
    }
    setInterventions((prev) => [payload, ...prev].slice(0, 100));
  });

  useGatewayEvent<RoomMetricsEvent>('room.metrics', (payload) => {
    if (!roomId || payload.roomId !== roomId) {
      return;
    }
    setMetrics(payload);
  });

  return useMemo(
    () => ({
      messages,
      memberStatus,
      runStatus,
      interventions,
      metrics,
    }),
    [messages, memberStatus, runStatus, interventions, metrics],
  );
}
