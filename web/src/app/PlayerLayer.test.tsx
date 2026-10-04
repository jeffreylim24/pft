// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakePlayer } from '../player/fakePlayer'
import { PlayerState } from '../player/player'
import { initialPlayerFacts, usePlayerStore } from '../player/store'
import type { PlaybackState, ServerMessage } from '../protocol/schemas'
import { FakeSocket, welcome } from '../test/fakeSocket'
import { PlayerLayer, type CreatePlayer } from './PlayerLayer'
import { applyServerMessage } from './roomState'
import { joinRoom, leaveRoom } from './session'
import { memoryStorage } from './storage'
import { initialAppState, useAppStore } from './store'

const VIDEO = 'dQw4w9WgXcQ'
const room = applyServerMessage(null, welcome('me') as ServerMessage)!
let player: FakePlayer
let createPlayer: CreatePlayer

function setPlayback(changes: Partial<PlaybackState>) {
  act(() =>
    useAppStore.setState((s) => ({ room: { ...s.room!, playback: { ...s.room!.playback, ...changes } } })),
  )
}

beforeEach(() => {
  player = new FakePlayer()
  createPlayer = () => player
  useAppStore.setState({ roomId: 'Kx81mZq2Tq0Rb2_9sLm0Qa', status: { kind: 'open' }, room })
})

afterEach(() => {
  cleanup()
  leaveRoom()
  vi.useRealTimers()
  useAppStore.setState(initialAppState)
  usePlayerStore.setState(initialPlayerFacts)
})

describe('PlayerLayer', () => {
  it("mounts the player and follows the room's playback", () => {
    render(<PlayerLayer createPlayer={createPlayer} />)
    expect(player.calls).toEqual([]) // no video yet
    setPlayback({ videoId: VIDEO, position: 42, updatedAt: Date.now() })
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause'])
    setPlayback({ playing: true, updatedAt: Date.now() })
    expect(player.calls.at(-1)).toBe('play')
  })

  it('destroys the player when it unmounts', () => {
    const { unmount } = render(<PlayerLayer createPlayer={createPlayer} />)
    unmount()
    expect(player.destroyed).toBe(true)
  })

  it('offers Start video when autoplay is blocked', () => {
    const { container } = render(<PlayerLayer createPlayer={createPlayer} />)
    player.blockAutoplay()
    setPlayback({ videoId: VIDEO, playing: true, updatedAt: Date.now() })
    expect(screen.getByText('Your browser blocked the video. Click the video to start it.')).toBeTruthy()
    expect(container.querySelector('.player-layer.clickable')).not.toBeNull()

    player.blockAutoplay(false)
    fireEvent.click(screen.getByRole('button', { name: 'Start video' }))
    expect(player.getState()).toBe(PlayerState.Playing)
    expect(screen.queryByRole('button', { name: 'Start video' })).toBeNull()
  })

  it("lets clicks reach the video while the room waits for this browser, so an ad's Skip works", () => {
    const { container } = render(<PlayerLayer createPlayer={createPlayer} />)
    setPlayback({ videoId: VIDEO, playing: true, updatedAt: Date.now() })
    expect(container.querySelector('.player-layer.clickable')).toBeNull()
    setPlayback({ playing: false, waitingFor: 'p2', autoResume: true })
    expect(container.querySelector('.player-layer.clickable')).toBeNull() // waiting for the partner
    setPlayback({ waitingFor: 'me' })
    expect(container.querySelector('.player-layer.clickable')).not.toBeNull()
    setPlayback({ playing: true, waitingFor: null, autoResume: false, updatedAt: Date.now() })
    expect(container.querySelector('.player-layer.clickable')).toBeNull()
  })
})

describe('PlayerLayer with a real RoomClient', () => {
  const NOW = 1_800_000_000_000

  function welcomeWith(playback: PlaybackState) {
    const w = welcome('me')
    return { ...w, snapshot: { ...w.snapshot, playback } }
  }

  /** Opens a socket that answers clock pings at once, so the offset is exactly 0. */
  function openSocket(): FakeSocket {
    const sock = FakeSocket.latest()
    sock.onSend = (msg) => {
      if (msg.type === 'ping') sock.receive({ type: 'pong', t0: msg.t0, serverTime: msg.t0 })
    }
    sock.open()
    return sock
  }

  it("after a reconnect, waits for the welcome instead of acting on the old state", async () => {
    vi.useFakeTimers({ toFake: ['Date'] }) // only the clock: the reconnect backoff runs on real timers
    vi.setSystemTime(NOW)
    FakeSocket.reset()
    useAppStore.setState(initialAppState)
    joinRoom(
      'Kx81mZq2Tq0Rb2_9sLm0Qa',
      { name: 'Alex', color: '#e4572e' },
      { page: { protocol: 'http:', host: 'localhost:5173' }, storage: memoryStorage(), createSocket: (url) => new FakeSocket(url) },
    )
    render(<PlayerLayer createPlayer={createPlayer} />)
    const playing = { videoId: VIDEO, playing: true, position: 10, updatedAt: NOW, waitingFor: null, autoResume: false }
    act(() => openSocket().receive(welcomeWith(playing)))
    expect(player.calls).toEqual([`load:${VIDEO}@10`, 'play'])

    vi.setSystemTime(NOW + 5_000) // the player reaches 15
    act(() => FakeSocket.latest().serverClose(1006))
    expect(player.calls.at(-1)).toBe('pause')
    const dropped = player.calls.length

    vi.setSystemTime(NOW + 20_000) // the old state would now expect 30
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2), { timeout: 2_000 })
    // The server paused the room at 15 and waits for this browser.
    const waiting = { ...playing, playing: false, position: 15, updatedAt: NOW + 6_000, waitingFor: 'me', autoResume: true }
    act(() => openSocket().receive(welcomeWith(waiting)))
    // Only the welcome's own play, to get ready: no seek or play toward the old state's 30.
    expect(player.calls.slice(dropped)).toEqual(['play'])
  })
})
