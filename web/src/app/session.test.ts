// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, welcome } from '../test/fakeSocket'
import { getRoomClient, joinRoom, leaveRoom, resetSession, syncSessionWithRoute } from './session'
import { memoryStorage, type StorageLike } from './storage'
import { useAppStore } from './store'

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'
const profile = { name: '  Alex ', color: '#e4572e' }
let storage: StorageLike

function join() {
  joinRoom(roomId, profile, {
    page: { protocol: 'http:', host: 'localhost:5173' },
    storage,
    createSocket: (url) => new FakeSocket(url),
  })
  return FakeSocket.latest()
}

beforeEach(() => {
  FakeSocket.reset()
  storage = memoryStorage()
  vi.useFakeTimers()
})

afterEach(() => {
  resetSession()
  vi.useRealTimers()
})

describe('session', () => {
  it('joins: connects to the room and fills the store from welcome', () => {
    const sock = join()
    expect(sock.url).toBe(`ws://localhost:5173/ws?room=${roomId}`)
    expect(useAppStore.getState()).toMatchObject({ roomId, status: { kind: 'connecting' }, room: null })

    sock.open()
    expect(sock.sent[0]).toMatchObject({ type: 'hello', name: 'Alex', color: '#e4572e' })
    sock.receive(welcome('me', 'tok-1'))
    expect(useAppStore.getState().status).toEqual({ kind: 'open' })
    expect(useAppStore.getState().room?.you).toBe('me')
    expect(storage.getItem(`popcorn.resume.${roomId}`)).toBe('tok-1')
  })

  it('rejoins with the token saved by an earlier page load', () => {
    storage.setItem(`popcorn.resume.${roomId}`, 'tok-old')
    const sock = join()
    sock.open()
    expect(sock.sent[0]).toMatchObject({ type: 'hello', resumeToken: 'tok-old' })
  })

  it('keeps room state current as messages arrive', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me'))
    sock.receive({ type: 'participant.joined', participant: { id: 'p2', name: 'Sam', color: '#2e86ab', pageSession: 'x' } })
    expect(useAppStore.getState().room?.participants.map((p) => p.name)).toEqual(['Alex', 'Sam'])
  })

  it('leaving sends leave, forgets the token, and empties the store', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me', 'tok-1'))
    leaveRoom()
    expect(sock.sent.at(-1)).toEqual({ type: 'leave' })
    expect(storage.getItem(`popcorn.resume.${roomId}`)).toBeNull()
    expect(useAppStore.getState()).toEqual({ roomId: null, status: { kind: 'idle' }, room: null })
    expect(getRoomClient()).toBeNull()
  })

  it('shows replaced when another tab takes over, and keeps the token for "use this tab"', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me', 'tok-1'))
    sock.serverClose(4001)
    expect(useAppStore.getState().status).toEqual({ kind: 'closed', reason: 'replaced' })
    resetSession()
    expect(useAppStore.getState().status).toEqual({ kind: 'idle' })
    expect(storage.getItem(`popcorn.resume.${roomId}`)).toBe('tok-1')
  })

  it('ignores a replaced client once a new one has started', () => {
    const first = join()
    first.open()
    const second = join() // joining again (e.g. "use this tab") replaces the client
    expect(first.closed).toBe(true)
    first.serverClose(4409)
    second.open()
    second.receive(welcome('me'))
    expect(useAppStore.getState().status).toEqual({ kind: 'open' })
  })

  it('leaves when the person navigates away from the room', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me'))
    syncSessionWithRoute({ page: 'room', roomId })
    expect(useAppStore.getState().roomId).toBe(roomId)
    syncSessionWithRoute({ page: 'landing' })
    expect(sock.sent.at(-1)).toEqual({ type: 'leave' })
    expect(useAppStore.getState().roomId).toBeNull()
  })
})

// By default the token lives in localStorage, so any tab in this browser
// (a duplicate, a new tab, the link reopened) counts as the same person.
describe('session with browser storage', () => {
  const key = `popcorn.resume.${roomId}`
  const joinDefault = () => {
    joinRoom(roomId, profile, {
      page: { protocol: 'http:', host: 'localhost:5173' },
      createSocket: (url) => new FakeSocket(url),
    })
    return FakeSocket.latest()
  }

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps the token where other tabs can read it', () => {
    const sock = joinDefault()
    sock.open()
    sock.receive(welcome('me', 'tok-1'))
    expect(localStorage.getItem(key)).toBe('tok-1')
  })

  it('resumes in a fresh tab with the token another tab saved', () => {
    localStorage.setItem(key, 'tok-other-tab')
    const sock = joinDefault()
    sock.open()
    expect(sock.sent[0]).toMatchObject({ type: 'hello', resumeToken: 'tok-other-tab' })
  })

  it('Leave forgets the token for every tab', () => {
    const sock = joinDefault()
    sock.open()
    sock.receive(welcome('me', 'tok-1'))
    expect(localStorage.getItem(key)).toBe('tok-1')
    leaveRoom()
    expect(localStorage.getItem(key)).toBeNull()
  })
})
