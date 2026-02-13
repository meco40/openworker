'use client';

import type { RoomSummary } from '../types';

interface RoomsColumnProps {
  rooms: RoomSummary[];
  selectedRoomId: string | null;
  loading: boolean;
  creating: boolean;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: () => void;
}

export function RoomsColumn({
  rooms,
  selectedRoomId,
  loading,
  creating,
  onSelectRoom,
  onCreateRoom,
}: RoomsColumnProps) {
  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-zinc-800">
      <div className="border-b border-zinc-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-black tracking-widest text-white uppercase">Rooms</h2>
          <button
            onClick={onCreateRoom}
            disabled={creating}
            className="rounded-lg bg-emerald-600 p-1.5 text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
            title="Neuen Room erstellen"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {loading && rooms.length === 0 && (
          <div className="py-8 text-center text-sm text-zinc-600">Laden...</div>
        )}
        {!loading && rooms.length === 0 && (
          <div className="py-8 text-center text-sm text-zinc-600">Keine Rooms erstellt.</div>
        )}
        {rooms.map((room) => (
          <button
            key={room.id}
            onClick={() => onSelectRoom(room.id)}
            className={`w-full rounded-xl border px-3 py-2.5 text-left transition-all ${
              selectedRoomId === room.id
                ? 'border-emerald-500/30 bg-emerald-600/20 text-white'
                : 'border-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-white'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-sm font-semibold">{room.name}</div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] tracking-wider uppercase ${
                  room.runState === 'running'
                    ? 'bg-emerald-600/20 text-emerald-300'
                    : room.runState === 'degraded'
                      ? 'bg-amber-700/30 text-amber-300'
                      : 'bg-zinc-700/60 text-zinc-300'
                }`}
              >
                {room.runState}
              </span>
            </div>
            <div className="mt-1 truncate text-[10px] text-zinc-500">
              {room.goalMode} • {room.routingProfileId}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
