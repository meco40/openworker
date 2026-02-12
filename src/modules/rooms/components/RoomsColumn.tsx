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
    <div className="w-72 shrink-0 border-r border-zinc-800 flex flex-col">
      <div className="p-4 border-b border-zinc-800">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-black text-white uppercase tracking-widest">Rooms</h2>
          <button
            onClick={onCreateRoom}
            disabled={creating}
            className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-60"
            title="Neuen Room erstellen"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading && rooms.length === 0 && (
          <div className="text-zinc-600 text-sm text-center py-8">Laden...</div>
        )}
        {!loading && rooms.length === 0 && (
          <div className="text-zinc-600 text-sm text-center py-8">
            Keine Rooms erstellt.
          </div>
        )}
        {rooms.map((room) => (
          <button
            key={room.id}
            onClick={() => onSelectRoom(room.id)}
            className={`w-full text-left px-3 py-2.5 rounded-xl transition-all border ${
              selectedRoomId === room.id
                ? 'bg-emerald-600/20 border-emerald-500/30 text-white'
                : 'hover:bg-zinc-800/60 text-zinc-400 hover:text-white border-transparent'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold truncate">{room.name}</div>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider ${
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
            <div className="text-[10px] text-zinc-500 truncate mt-1">
              {room.goalMode} • {room.routingProfileId}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
