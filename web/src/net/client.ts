// RoomClient is the only code that talks to the server. It owns one
// WebSocket at a time: it sends hello, reconnects with backoff, resumes the
// same seat with the resume token, measures the clock offset, and notices a
// connection that has silently died.
import {
  clientMessage,
  CloseCode,
  serverMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageOf,
} from '../protocol/schemas'
import { backoffDelay } from './backoff'
import { bestOffset, sampleFromPong, type ClockSample } from './clock'

export const CLOCK_SAMPLES = 5
export const CLOCK_INTERVAL_MS = 30_000
export const HEARTBEAT_MS = 10_000
export const PONG_TIMEOUT_MS = 5_000
export const WELCOME_TIMEOUT_MS = 10_000

/** Why the client stopped for good. It never reconnects after these. */
export type CloseReason = 'left' | 'replaced' | 'room_full' | 'not_found' | 'rejected'

export type ConnectionStatus =
  | { kind: 'connecting' } // the first attempt, until welcome
  | { kind: 'open' } // welcomed; messages flow
  | { kind: 'reconnecting'; attempt: number } // waiting to retry, or retrying
  | { kind: 'closed'; reason: CloseReason }

const terminalCloses: Record<number, CloseReason> = {
  [CloseCode.Normal]: 'left',
  [CloseCode.Replaced]: 'replaced',
  [CloseCode.BadMessage]: 'rejected',
  [CloseCode.NotFound]: 'not_found',
  [CloseCode.RoomFull]: 'room_full',
}

/** The parts of the browser WebSocket the client uses, so tests can fake it. */
export interface SocketLike {
  onopen: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  send(data: string): void
  close(): void
}

export interface RoomClientOptions {
  url: string
  hello: { name: string; color: string; pageSession: string }
  /** A token from an earlier welcome in this tab; it reclaims the same seat. */
  resumeToken?: string | null
  /** Called with each welcome's token so the caller can keep it across reloads. */
  onResumeToken?: (token: string) => void
  createSocket?: (url: string) => SocketLike
}

type Timer = ReturnType<typeof setTimeout>

export class RoomClient {
  private readonly opts: RoomClientOptions
  private readonly createSocket: (url: string) => SocketLike
  private readonly messageListeners = new Set<(msg: ServerMessage) => void>()
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>()
  private ws: SocketLike | null = null
  private current: ConnectionStatus = { kind: 'connecting' }
  private failures = 0
  private resumeToken: string | undefined
  private offsetMs: number | null = null
  private samples: ClockSample[] = []
  private clockPing: number | null = null // t0 of the clock ping awaiting its pong
  private retryTimer: Timer | undefined
  private clockTimer: Timer | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private replyDeadline: Timer | undefined

  constructor(opts: RoomClientOptions) {
    this.opts = opts
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url))
    this.resumeToken = opts.resumeToken || undefined
  }

  get status(): ConnectionStatus {
    return this.current
  }

  /** Server clock minus local clock in ms, or null until first measured. */
  get clockOffsetMs(): number | null {
    return this.offsetMs
  }

  /** The server's current time in Unix ms. */
  serverNow(): number {
    return Date.now() + (this.offsetMs ?? 0)
  }

  /** Every valid server message, in order. Returns an unsubscribe function. */
  subscribe(listener: (msg: ServerMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  connect(): void {
    if (this.ws === null && this.retryTimer === undefined && this.current.kind !== 'closed') this.open()
  }

  /**
   * Sends a message if the room is joined. Returns false, sending nothing,
   * while connecting or reconnecting, or if the message would be rejected.
   */
  send(msg: ClientMessage): boolean {
    if (this.current.kind !== 'open') return false
    const checked = clientMessage.safeParse(msg)
    if (!checked.success) {
      console.error('Not sending an invalid message', msg, checked.error.issues)
      return false
    }
    this.raw(checked.data)
    return true
  }

  /** Leaves on purpose: the server frees the seat at once. */
  leave(): void {
    if (this.current.kind === 'closed') return
    if (this.current.kind === 'open') this.raw({ type: 'leave' })
    this.finish('left')
  }

  private open(): void {
    const ws = this.createSocket(this.opts.url)
    this.ws = ws
    ws.onopen = () => {
      this.raw({ type: 'hello', ...this.opts.hello, ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}) })
    }
    ws.onmessage = (ev) => this.receive(ev.data)
    ws.onclose = (ev) => this.socketClosed(ev.code)
    // Covers a server that never answers, and a connection attempt that hangs.
    this.expectReply(WELCOME_TIMEOUT_MS)
  }

  private raw(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg))
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      console.warn('Ignoring a message that is not JSON', data)
      return
    }
    const parsed = serverMessage.safeParse(json)
    if (!parsed.success) {
      console.warn('Ignoring a message the client does not understand', json, parsed.error.issues)
      return
    }
    const msg = parsed.data
    // Anything from the server proves the connection is alive.
    clearTimeout(this.replyDeadline)
    this.replyDeadline = undefined
    if (msg.type === 'welcome') this.welcomed(msg)
    if (msg.type === 'pong') this.pong(msg)
    for (const listener of this.messageListeners) listener(msg)
  }

  private welcomed(msg: ServerMessageOf<'welcome'>): void {
    this.failures = 0
    this.resumeToken = msg.resumeToken
    this.opts.onResumeToken?.(msg.resumeToken)
    this.setStatus({ kind: 'open' })
    this.startClockRound()
    this.heartbeatTimer = setInterval(() => this.ping(false), HEARTBEAT_MS)
  }

  // State is set before sending, so even an instant reply finds it.
  private ping(forClock: boolean): void {
    const t0 = Date.now()
    if (forClock) this.clockPing = t0
    this.expectReply(PONG_TIMEOUT_MS)
    this.raw({ type: 'ping', t0 })
  }

  private startClockRound(): void {
    this.samples = []
    this.ping(true)
  }

  // Clock pings go one at a time, so no ping waits in a queue behind another.
  private pong(msg: ServerMessageOf<'pong'>): void {
    if (msg.t0 !== this.clockPing) return // a heartbeat, not part of a round
    this.samples.push(sampleFromPong(msg.t0, Date.now(), msg.serverTime))
    if (this.samples.length < CLOCK_SAMPLES) {
      this.ping(true)
      return
    }
    this.clockPing = null
    this.offsetMs = bestOffset(this.samples)
    this.clockTimer = setTimeout(() => this.startClockRound(), CLOCK_INTERVAL_MS)
  }

  /** If nothing at all arrives within ms, the connection is treated as dead. */
  private expectReply(ms: number): void {
    this.replyDeadline ??= setTimeout(() => {
      this.replyDeadline = undefined
      console.warn('The server stopped answering; reconnecting')
      this.retry()
    }, ms)
  }

  private socketClosed(code: number): void {
    const reason = terminalCloses[code]
    if (reason) this.finish(reason)
    else this.retry()
  }

  private retry(): void {
    this.dropSocket()
    this.failures += 1
    this.setStatus({ kind: 'reconnecting', attempt: this.failures })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.open()
    }, backoffDelay(this.failures - 1))
  }

  private finish(reason: CloseReason): void {
    this.dropSocket()
    this.setStatus({ kind: 'closed', reason })
  }

  // Detaches the socket first, so a late event from it can't affect the
  // client, then closes it. Also stops every timer.
  private dropSocket(): void {
    const ws = this.ws
    this.ws = null
    clearTimeout(this.retryTimer)
    clearTimeout(this.clockTimer)
    clearTimeout(this.replyDeadline)
    clearInterval(this.heartbeatTimer)
    this.retryTimer = this.clockTimer = this.replyDeadline = this.heartbeatTimer = undefined
    this.clockPing = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null
      ws.close()
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.current = status
    for (const listener of this.statusListeners) listener(status)
  }
}
