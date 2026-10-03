// The client's copy of the room, rebuilt from server messages only. Local
// in-progress gestures (dragging a cam, drawing) live with the components
// doing them, not here.
import type {
  CamState,
  IceServer,
  PlaybackState,
  ServerMessage,
  SnapshotParticipant,
  Stroke,
} from '../protocol/schemas'

export interface RoomState {
  you: string
  polite: boolean
  iceServers: IceServer[]
  participants: SnapshotParticipant[]
  playback: PlaybackState
  cams: Record<string, CamState>
  stickyStrokes: Stroke[]
}

/**
 * The room after msg. Messages that don't change room state (pongs,
 * cursors, live ink, signals, errors) return the same object, so subscribers
 * don't re-render. Sticky ink.points are added in plan 5, with the server's
 * trimming rules.
 */
export function applyServerMessage(room: RoomState | null, msg: ServerMessage): RoomState | null {
  if (msg.type === 'welcome') {
    return {
      you: msg.you,
      polite: msg.polite,
      iceServers: msg.iceServers,
      participants: msg.snapshot.participants,
      playback: msg.snapshot.playback,
      cams: msg.snapshot.cams,
      stickyStrokes: msg.snapshot.stickyStrokes,
    }
  }
  if (room === null) return null // nothing applies before the first welcome
  switch (msg.type) {
    case 'participant.joined': {
      const joined = { ...msg.participant, connected: true }
      const exists = room.participants.some((p) => p.id === joined.id)
      return {
        ...room,
        participants: exists
          ? room.participants.map((p) => (p.id === joined.id ? joined : p))
          : [...room.participants, joined],
      }
    }
    case 'participant.reconnecting':
      return {
        ...room,
        participants: room.participants.map((p) => (p.id === msg.id ? { ...p, connected: false } : p)),
      }
    case 'participant.left': {
      const cams = { ...room.cams }
      delete cams[msg.id]
      return { ...room, participants: room.participants.filter((p) => p.id !== msg.id), cams }
    }
    case 'playback':
      return { ...room, playback: msg.state }
    case 'cam':
      return { ...room, cams: { ...room.cams, [msg.camId]: { rect: msg.rect, holder: msg.holder } } }
    case 'ink.clear':
      return { ...room, stickyStrokes: [] }
    default:
      return room
  }
}
