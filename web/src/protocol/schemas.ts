// The JSON messages exchanged with the server over the WebSocket. These
// mirror server/internal/protocol by hand; the files in protocol-fixtures/
// keep the two sides in sync (see fixtures.test.ts).
//
// Client schemas enforce the server's validation rules, so the client never
// sends something the server would reject. Server schemas only check shape,
// so a stricter rule on our side can't make us drop a real message.
import { z } from 'zod'

// Limits from server/internal/protocol/validate.go.
export const MAX_NAME_CHARS = 32
export const MAX_ID_LENGTH = 64
export const MAX_INK_BATCH = 64

// WebSocket close codes the server uses.
export const CloseCode = {
  Normal: 1000, // the participant left on purpose
  Replaced: 4001, // the same participant connected again elsewhere
  BadMessage: 4400, // the first message wasn't a valid hello
  NotFound: 4404,
  RoomFull: 4409,
} as const

// Codes sent in error messages.
export const ErrorCode = {
  BadMessage: 'bad_message',
  RateLimited: 'rate_limited',
  RoomFull: 'room_full',
  NotFound: 'not_found',
} as const

/** Names are counted in code points, like Go counts runes. */
export function nameLength(name: string): number {
  return [...name.trim()].length
}

const id = z.string().min(1).max(MAX_ID_LENGTH)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/)
const name = z.string().refine((s) => {
  const n = nameLength(s)
  return n >= 1 && n <= MAX_NAME_CHARS
}, `must be 1-${MAX_NAME_CHARS} characters`)
// A WebRTC description or ICE candidate; the server passes it through unread.
const signalData = z.record(z.string(), z.unknown())

// ---- Shared shapes ----

export const rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
export const point = z.tuple([z.number(), z.number()])
export const inkMode = z.enum(['fading', 'sticky'])
export const participant = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  pageSession: z.string(),
})
export const snapshotParticipant = participant.extend({ connected: z.boolean() })
export const playbackState = z.object({
  videoId: z.string().nullable(),
  playing: z.boolean(),
  position: z.number(), // seconds, as of updatedAt
  updatedAt: z.number(), // server Unix milliseconds
  waitingFor: z.string().nullable(),
  autoResume: z.boolean(),
})
export const camState = z.object({ rect, holder: z.string().nullable() })
export const stroke = z.object({
  id: z.string(),
  author: z.string(),
  color: z.string(),
  width: z.number(),
  points: z.array(point),
})
export const snapshot = z.object({
  participants: z.array(snapshotParticipant),
  playback: playbackState,
  cams: z.record(z.string(), camState),
  stickyStrokes: z.array(stroke),
})
export const iceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
})

// ---- Client → server ----

export const clientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    name,
    color,
    pageSession: id,
    resumeToken: z.string().max(MAX_ID_LENGTH).optional(),
  }),
  z.object({ type: z.literal('ping'), t0: z.number() }),
  z.object({ type: z.literal('playback.load'), videoId }),
  z.object({ type: z.literal('playback.play'), position: z.number() }),
  z.object({ type: z.literal('playback.pause'), position: z.number() }),
  z.object({ type: z.literal('playback.seek'), position: z.number() }),
  z.object({ type: z.literal('playback.stalled') }),
  z.object({ type: z.literal('playback.ready') }),
  z.object({ type: z.literal('cam.grab'), camId: id }),
  z.object({ type: z.literal('cam.move'), camId: id, rect }),
  z.object({ type: z.literal('cam.release'), camId: id, rect }),
  z.object({ type: z.literal('cursor'), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('cursor.hide') }),
  z.object({
    type: z.literal('ink.points'),
    strokeId: id,
    mode: inkMode,
    color,
    width: z.number(),
    points: z.array(point).min(1).max(MAX_INK_BATCH),
  }),
  z.object({ type: z.literal('ink.end'), strokeId: id }),
  z.object({ type: z.literal('ink.clear') }),
  z.object({ type: z.literal('signal'), data: signalData }),
  z.object({ type: z.literal('leave') }),
])

// ---- Server → client ----

export const serverMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    you: z.string(),
    resumeToken: z.string(),
    polite: z.boolean(),
    iceServers: z.array(iceServer),
    snapshot,
  }),
  z.object({ type: z.literal('pong'), t0: z.number(), serverTime: z.number() }),
  z.object({ type: z.literal('participant.joined'), participant }),
  z.object({ type: z.literal('participant.reconnecting'), id: z.string() }),
  z.object({ type: z.literal('participant.left'), id: z.string() }),
  z.object({ type: z.literal('playback'), state: playbackState }),
  z.object({ type: z.literal('cam'), camId: z.string(), rect, holder: z.string().nullable() }),
  z.object({ type: z.literal('cursor'), from: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('cursor.hide'), from: z.string() }),
  z.object({
    type: z.literal('ink.points'),
    from: z.string(),
    strokeId: z.string(),
    mode: inkMode,
    color: z.string(),
    width: z.number(),
    points: z.array(point),
  }),
  z.object({ type: z.literal('ink.end'), from: z.string(), strokeId: z.string() }),
  z.object({ type: z.literal('ink.clear'), from: z.string() }),
  z.object({ type: z.literal('signal'), from: z.string(), data: signalData }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])

/** Every message type, like Go's ClientTypes() and ServerTypes(). */
export const clientTypes: string[] = clientMessage.options.map((o) => o.shape.type.value)
export const serverTypes: string[] = serverMessage.options.map((o) => o.shape.type.value)

export type ClientMessage = z.infer<typeof clientMessage>
export type ServerMessage = z.infer<typeof serverMessage>
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>
export type Rect = z.infer<typeof rect>
export type Point = z.infer<typeof point>
export type InkMode = z.infer<typeof inkMode>
export type Participant = z.infer<typeof participant>
export type SnapshotParticipant = z.infer<typeof snapshotParticipant>
export type PlaybackState = z.infer<typeof playbackState>
export type CamState = z.infer<typeof camState>
export type Stroke = z.infer<typeof stroke>
export type Snapshot = z.infer<typeof snapshot>
export type IceServer = z.infer<typeof iceServer>
