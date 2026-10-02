import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, welcome } from '../test/fakeSocket'
import { CLOCK_INTERVAL_MS, HEARTBEAT_MS, PONG_TIMEOUT_MS, RoomClient, WELCOME_TIMEOUT_MS, type RoomClientOptions } from './client'

const hello = { name: 'Alex', color: '#e4572e', pageSession: 'ps-1' }

function makeClient(extra: Partial<RoomClientOptions> = {}) {
  const client = new RoomClient({
    url: 'ws://test/ws?room=r1',
    hello,
    createSocket: (url) => new FakeSocket(url),
    ...extra,
  })
  client.connect()
  return client
}

/** Connects and gets welcomed; returns the socket. */
function join(client: RoomClient, token = 'token-1') {
  const sock = FakeSocket.latest()
  sock.open()
  sock.receive(welcome('me', token))
  expect(client.status).toEqual({ kind: 'open' })
  return sock
}

/** Answers every ping as a server whose clock is `offset` ms ahead, instantly. */
function autoPong(sock: FakeSocket, offset = 0) {
  sock.onSend = (msg) => {
    if (msg.type === 'ping') sock.receive({ type: 'pong', t0: msg.t0, serverTime: Date.now() + offset })
  }
}

beforeEach(() => {
  FakeSocket.reset()
  vi.useFakeTimers()
  vi.setSystemTime(1_790_000_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('handshake', () => {
  it('sends hello when the socket opens and is open after welcome', () => {
    const client = makeClient()
    const statuses: string[] = []
    client.onStatus((s) => statuses.push(s.kind))
    const sock = FakeSocket.latest()
    expect(sock.url).toBe('ws://test/ws?room=r1')
    expect(client.status).toEqual({ kind: 'connecting' })

    sock.open()
    expect(sock.sent[0]).toEqual({ type: 'hello', ...hello })

    sock.receive(welcome())
    expect(statuses).toEqual(['open'])
  })

  it('includes a stored resume token in hello', () => {
    makeClient({ resumeToken: 'saved-token' })
    const sock = FakeSocket.latest()
    sock.open()
    expect(sock.sent[0]).toEqual({ type: 'hello', ...hello, resumeToken: 'saved-token' })
  })

  it('hands every welcome token to onResumeToken', () => {
    const tokens: string[] = []
    const client = makeClient({ onResumeToken: (t) => tokens.push(t) })
    join(client, 'token-A')
    expect(tokens).toEqual(['token-A'])
  })

  it('passes valid server messages to subscribers and drops invalid ones', () => {
    const client = makeClient()
    const got: string[] = []
    client.subscribe((m) => got.push(m.type))
    const sock = join(client)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    sock.receive({ type: 'cursor', from: 'p2', x: 0.5, y: 0.5 })
    sock.receive({ type: 'cursor', from: 'p2', x: 'left' }) // wrong field type
    sock.receive({ type: 'dance' }) // unknown type
    sock.receive('not json {')
    expect(got).toEqual(['welcome', 'cursor'])
  })
})

describe('sending', () => {
  it('refuses to send before welcome', () => {
    const client = makeClient()
    FakeSocket.latest().open()
    expect(client.send({ type: 'cursor', x: 0.5, y: 0.5 })).toBe(false)
  })

  it('sends valid messages once open', () => {
    const client = makeClient()
    const sock = join(client)
    expect(client.send({ type: 'cursor', x: 0.5, y: 0.5 })).toBe(true)
    expect(sock.sentOfType('cursor')).toEqual([{ type: 'cursor', x: 0.5, y: 0.5 }])
  })

  it('refuses a message the server would reject', () => {
    const client = makeClient()
    const sock = join(client)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(client.send({ type: 'playback.load', videoId: 'nope' })).toBe(false)
    expect(sock.sentOfType('playback.load')).toEqual([])
  })
})

describe('reconnecting', () => {
  it('backs off 0.5s, 1s, 2s, 4s, then 8s between failed attempts', () => {
    const client = makeClient()
    join(client).serverClose(1006)

    const waits: number[] = []
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(client.status).toEqual({ kind: 'reconnecting', attempt })
      const before = FakeSocket.all.length
      let waited = 0
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(100)
        waited += 100
      }
      waits.push(waited)
      FakeSocket.latest().serverClose(1006) // the attempt fails
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000])
  })

  it('resumes with the latest token and starts the backoff over after a welcome', () => {
    const client = makeClient()
    join(client, 'token-1').serverClose(1006)
    vi.advanceTimersByTime(500)
    FakeSocket.latest().serverClose(1006)
    vi.advanceTimersByTime(1000)

    const sock = FakeSocket.latest()
    sock.open()
    expect(sock.sent[0]).toMatchObject({ type: 'hello', resumeToken: 'token-1' })
    sock.receive(welcome('me', 'token-1'))
    expect(client.status).toEqual({ kind: 'open' })

    sock.serverClose(1006)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
    vi.advanceTimersByTime(500)
    expect(FakeSocket.all).toHaveLength(4)
  })

  it.each([
    [4001, 'replaced'],
    [4404, 'not_found'],
    [4409, 'room_full'],
    [4400, 'rejected'],
    [1000, 'left'],
  ])('stops for good on close code %i (%s)', (code, reason) => {
    const client = makeClient()
    const sock = FakeSocket.latest()
    sock.open()
    sock.serverClose(code)
    expect(client.status).toEqual({ kind: 'closed', reason })
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('stops for good when replaced by another tab while open', () => {
    const client = makeClient()
    join(client).serverClose(4001)
    expect(client.status).toEqual({ kind: 'closed', reason: 'replaced' })
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('ignores a late event from a socket it has given up on', () => {
    const client = makeClient()
    const first = join(client)
    first.serverClose(1006)
    vi.advanceTimersByTime(500)
    const second = FakeSocket.latest()
    second.open()
    second.receive(welcome())

    first.receive({ type: 'participant.left', id: 'me' })
    first.serverClose(4409)
    expect(client.status).toEqual({ kind: 'open' })
  })

  it('gives up on a connection that never gets a welcome', () => {
    const client = makeClient()
    FakeSocket.latest().open()
    vi.advanceTimersByTime(WELCOME_TIMEOUT_MS)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
    expect(FakeSocket.all[0].closed).toBe(true)
  })
})

describe('leaving', () => {
  it('sends leave, closes the socket, and never reconnects', () => {
    const client = makeClient()
    const sock = join(client)
    client.leave()
    expect(sock.sent.at(-1)).toEqual({ type: 'leave' })
    expect(sock.closed).toBe(true)
    expect(client.status).toEqual({ kind: 'closed', reason: 'left' })
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('stops retrying when leaving while reconnecting', () => {
    const client = makeClient()
    join(client).serverClose(1006)
    client.leave()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(client.status).toEqual({ kind: 'closed', reason: 'left' })
  })
})

describe('clock offset', () => {
  it('pings five times, one at a time, and keeps the fastest round trip', () => {
    const client = makeClient()
    const sock = join(client)
    expect(client.clockOffsetMs).toBeNull()

    // The server is 5000ms ahead. Replies with a long round trip are also
    // lopsided, so they would give a worse estimate.
    const rtts = [120, 40, 300, 20, 90]
    const skews = [30, 8, -100, 0, 15]
    for (let i = 0; i < 5; i++) {
      const pings = sock.sentOfType('ping')
      expect(pings).toHaveLength(i + 1) // the next ping waits for this pong
      const t0 = pings[i].t0 as number
      vi.advanceTimersByTime(rtts[i])
      sock.receive({ type: 'pong', t0, serverTime: t0 + rtts[i] / 2 + 5000 + skews[i] })
    }
    expect(client.clockOffsetMs).toBe(5000)
    expect(client.serverNow()).toBe(Date.now() + 5000)
  })

  it('measures again every 30 seconds', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock, 250)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() + 250 }) // the first ping went out before autoPong
    expect(client.clockOffsetMs).toBe(250)
    const clockPings = () => sock.sentOfType('ping').length

    const afterFirstRound = clockPings()
    expect(afterFirstRound).toBe(5)
    autoPong(sock, -700)
    vi.advanceTimersByTime(CLOCK_INTERVAL_MS)
    expect(client.clockOffsetMs).toBe(-700)
    // Five more for the new round, plus the heartbeats in between.
    expect(clockPings()).toBe(afterFirstRound + 5 + Math.floor(CLOCK_INTERVAL_MS / HEARTBEAT_MS))
  })

  it('treats heartbeat pongs as heartbeats, not clock samples', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock, 100)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() + 100 })
    autoPong(sock, 99_999) // nonsense, but only heartbeats go out now
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    expect(client.clockOffsetMs).toBe(100)
  })
})

describe('heartbeat', () => {
  it('reconnects when a ping gets no answer', () => {
    const client = makeClient()
    join(client) // the first clock ping is never answered
    vi.advanceTimersByTime(PONG_TIMEOUT_MS - 1)
    expect(client.status).toEqual({ kind: 'open' })
    vi.advanceTimersByTime(1)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
    expect(FakeSocket.all[0].closed).toBe(true)
  })

  it('stays open while pongs keep arriving', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() })
    vi.advanceTimersByTime(5 * 60_000)
    expect(client.status).toEqual({ kind: 'open' })
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('reconnects when the server goes quiet between pings', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() })
    sock.onSend = null // the connection dies silently
    vi.advanceTimersByTime(HEARTBEAT_MS + PONG_TIMEOUT_MS)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
  })
})
