import { create } from 'zustand'
import type { ConnectionStatus } from '../net/client'
import type { RoomState } from './roomState'

/** idle: not joined (the lobby). Otherwise the RoomClient's status. */
export type SessionStatus = { kind: 'idle' } | ConnectionStatus

export interface AppState {
  roomId: string | null
  status: SessionStatus
  room: RoomState | null
}

export const initialAppState: AppState = { roomId: null, status: { kind: 'idle' }, room: null }

/** Written only by session.ts, from server messages and connection status. */
export const useAppStore = create<AppState>()(() => initialAppState)
