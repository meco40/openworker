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

export function upsertRoomMessage(previous: RoomMessage[], incoming: RoomMessage): RoomMessage[] {
  if (previous.some((item) => item.id === incoming.id || item.seq === incoming.seq)) {
    return previous;
  }

  if (previous.length === 0 || previous[previous.length - 1]!.seq < incoming.seq) {
    return [...previous, incoming];
  }

  const next = [...previous];
  const insertIndex = next.findIndex((item) => item.seq > incoming.seq);
  if (insertIndex === -1) {
    next.push(incoming);
  } else {
    next.splice(insertIndex, 0, incoming);
  }
  return next;
}

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

    setMessages((prev) => upsertRoomMessage(prev, payload));
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
