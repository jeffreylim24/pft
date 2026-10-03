// A stand-in for the browser WebSocket, driven by the test.
import type { SocketLike } from '../net/client'

export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []

  static latest(): FakeSocket {
    const s = FakeSocket.all.at(-1)
    if (!s) throw new Error('no socket was created')
    return s
  }

  static reset(): void {
    FakeSocket.all = []
  }

  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  closed = false
  /** Called after every send; lets a test answer pings automatically. */
  onSend: ((msg: Record<string, unknown>) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>
    this.sent.push(msg)
    this.onSend?.(msg)
  }

  close(): void {
    this.closed = true
  }

  // ---- driven by the test ----

  open(): void {
    this.onopen?.({} as Event)
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) } as MessageEvent)
  }

  serverClose(code: number): void {
    this.onclose?.({ code } as CloseEvent)
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type)
  }
}

export function welcome(you = 'me', resumeToken = 'token-1') {
  return {
    type: 'welcome',
    you,
    resumeToken,
    polite: false,
    iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    snapshot: {
      participants: [{ id: you, name: 'Alex', color: '#e4572e', pageSession: 'ps-1', connected: true }],
      playback: { videoId: null, playing: false, position: 0, updatedAt: 0, waitingFor: null, autoResume: false },
      cams: { [you]: { rect: { x: 0.02, y: 0.745, w: 0.22, h: 0.22 }, holder: null } },
      stickyStrokes: [],
    },
  }
}
