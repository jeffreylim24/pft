// RoomClient against the real Go server. Skipped unless POPCORN_SERVER is
// set, for example:
//   POPCORN_SERVER=http://localhost:8099 npx vitest run src/net/client.server.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../protocol/schemas'
import { RoomClient, type SocketLike } from './client'
import { randomId } from './ids'
import { roomSocketUrl } from './url'

const base = process.env.POPCORN_SERVER
const opened: RoomClient[] = []

async function createRoom(): Promise<string> {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST' })
  expect(res.status).toBe(201)
  return ((await res.json()) as { roomId: string }).roomId
}

function connect(roomId: string, name: string, extra: { resumeToken?: string; sockets?: SocketLike[] } = {}) {
  const messages: ServerMessage[] = []
  const client = new RoomClient({
    url: roomSocketUrl(new URL(base!), roomId),
    hello: { name, color: '#e4572e', pageSession: randomId() },
    resumeToken: extra.resumeToken,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      extra.sockets?.push(ws)
      return ws
    },
  })
  client.subscribe((m) => messages.push(m))
  client.connect()
  opened.push(client)
  return { client, messages }
}

function welcomeOf(messages: ServerMessage[]) {
  const w = messages.find((m) => m.type === 'welcome')
  if (!w) throw new Error('no welcome yet')
  return w
}

const waitOpts = { timeout: 3000, interval: 20 }

afterEach(() => {
  for (const c of opened.splice(0)) c.leave()
})

describe.skipIf(!base)('RoomClient against the Go server', () => {
  it('joins, sees the partner arrive, and frees the seat on leave', async () => {
    const roomId = await createRoom()
    const a = connect(roomId, 'Alex')
    await vi.waitFor(() => expect(a.client.status.kind).toBe('open'), waitOpts)
    const b = connect(roomId, 'Sam')
    await vi.waitFor(() => expect(b.client.status.kind).toBe('open'), waitOpts)

    const bWelcome = welcomeOf(b.messages)
    expect(bWelcome.snapshot.participants.map((p) => p.name)).toEqual(['Alex', 'Sam'])
    expect(bWelcome.polite).toBe(!welcomeOf(a.messages).polite)
    await vi.waitFor(() => expect(a.messages.some((m) => m.type === 'participant.joined')).toBe(true), waitOpts)

    b.client.leave()
    expect(b.client.status).toEqual({ kind: 'closed', reason: 'left' })
    await vi.waitFor(
      () => expect(a.messages.some((m) => m.type === 'participant.left' && m.id === bWelcome.you)).toBe(true),
      waitOpts,
    )
    // The seat is free at once, so a third person fits.
    const c = connect(roomId, 'Kim')
    await vi.waitFor(() => expect(c.client.status.kind).toBe('open'), waitOpts)
  })

  it('measures a clock offset near zero against a local server', async () => {
    const roomId = await createRoom()
    const a = connect(roomId, 'Alex')
    await vi.waitFor(() => expect(a.client.clockOffsetMs).not.toBeNull(), waitOpts)
    expect(Math.abs(a.client.clockOffsetMs!)).toBeLessThan(50)
  })

  it('reports room_full to a third person', async () => {
    const roomId = await createRoom()
    const a = connect(roomId, 'Alex')
    const b = connect(roomId, 'Sam')
    await vi.waitFor(() => expect([a.client.status.kind, b.client.status.kind]).toEqual(['open', 'open']), waitOpts)
    const c = connect(roomId, 'Kim')
    await vi.waitFor(() => expect(c.client.status).toEqual({ kind: 'closed', reason: 'room_full' }), waitOpts)
    expect(c.messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'room_full' }))
  })

  it('reports not_found for an unknown room', async () => {
    const a = connect('AAAAAAAAAAAAAAAAAAAAAA', 'Alex')
    await vi.waitFor(() => expect(a.client.status).toEqual({ kind: 'closed', reason: 'not_found' }), waitOpts)
  })

  it('gets the same seat back after its connection drops', async () => {
    const roomId = await createRoom()
    const sockets: SocketLike[] = []
    const a = connect(roomId, 'Alex', { sockets })
    const b = connect(roomId, 'Sam')
    await vi.waitFor(() => expect([a.client.status.kind, b.client.status.kind]).toEqual(['open', 'open']), waitOpts)
    const me = welcomeOf(a.messages).you

    sockets[0].close() // the network drops
    await vi.waitFor(() => expect(a.client.status.kind).toBe('reconnecting'), waitOpts)
    await vi.waitFor(() => expect(a.client.status.kind).toBe('open'), waitOpts)
    const welcomes = a.messages.filter((m) => m.type === 'welcome')
    expect(welcomes).toHaveLength(2)
    expect(welcomes[1].you).toBe(me)
    expect(b.messages.map((m) => m.type)).toContain('participant.reconnecting')
  })

  it('a second tab with the same token takes over, and the first stops for good', async () => {
    const roomId = await createRoom()
    const first = connect(roomId, 'Alex')
    await vi.waitFor(() => expect(first.client.status.kind).toBe('open'), waitOpts)
    const token = welcomeOf(first.messages).resumeToken

    const second = connect(roomId, 'Alex', { resumeToken: token })
    await vi.waitFor(() => expect(second.client.status.kind).toBe('open'), waitOpts)
    await vi.waitFor(() => expect(first.client.status).toEqual({ kind: 'closed', reason: 'replaced' }), waitOpts)
    expect(welcomeOf(second.messages).you).toBe(welcomeOf(first.messages).you)
  })
})
