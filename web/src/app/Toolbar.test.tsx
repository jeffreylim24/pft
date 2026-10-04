// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialPlayerFacts, usePlayerStore } from '../player/store'
import type { PlaybackState } from '../protocol/schemas'
import { FakeSocket, welcome } from '../test/fakeSocket'
import { joinRoom, leaveRoom } from './session'
import { memoryStorage } from './storage'
import { useAppStore } from './store'
import { Toolbar } from './Toolbar'

const VIDEO = 'dQw4w9WgXcQ'
const NOW = 1_800_000_000_000
let sock: FakeSocket

/** Renders the toolbar with whatever room the store holds, like RoomPage. */
function Harness() {
  const room = useAppStore((s) => s.room)
  return room ? <Toolbar room={room} /> : null
}

function playback(changes: Partial<PlaybackState>) {
  act(() =>
    sock.receive({
      type: 'playback',
      state: { videoId: VIDEO, playing: false, position: 0, updatedAt: NOW, waitingFor: null, autoResume: false, ...changes },
    }),
  )
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }) // only the clock: React and testing-library keep real timers
  vi.setSystemTime(NOW)
  usePlayerStore.setState(initialPlayerFacts)
  FakeSocket.reset()
  joinRoom(
    'Kx81mZq2Tq0Rb2_9sLm0Qa',
    { name: 'Alex', color: '#e4572e' },
    { page: { protocol: 'http:', host: 'localhost:5173' }, storage: memoryStorage(), createSocket: (url) => new FakeSocket(url) },
  )
  sock = FakeSocket.latest()
  // Answer clock pings at once, so the measured offset is exactly 0.
  sock.onSend = (msg) => {
    if (msg.type === 'ping') sock.receive({ type: 'pong', t0: msg.t0, serverTime: msg.t0 })
  }
  sock.open()
  sock.receive(welcome('me'))
  render(<Harness />)
})

afterEach(() => {
  cleanup()
  leaveRoom()
  vi.useRealTimers()
})

describe('Toolbar playback controls', () => {
  it('loads a pasted link: sends playback.load and clears the box', () => {
    const box = screen.getByRole('textbox', { name: 'YouTube link' }) as HTMLInputElement
    fireEvent.change(box, { target: { value: `https://youtu.be/${VIDEO}?si=abc` } })
    fireEvent.click(button('Load'))
    expect(sock.sentOfType('playback.load')).toEqual([{ type: 'playback.load', videoId: VIDEO }])
    expect(box.value).toBe('')
  })

  it("shows an error for a link it can't read, and sends nothing", () => {
    const box = screen.getByRole('textbox', { name: 'YouTube link' })
    fireEvent.change(box, { target: { value: 'https://vimeo.com/123456789' } })
    fireEvent.click(button('Load'))
    expect(screen.getByRole('alert').textContent).toBe("That isn't a YouTube link.")
    expect(sock.sentOfType('playback.load')).toEqual([])
    fireEvent.change(box, { target: { value: 'https://vimeo.com/12345678' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('play sends the room position; pause sends where the room is now', () => {
    playback({ position: 30 })
    fireEvent.click(button('Play'))
    expect(sock.sentOfType('playback.play')).toEqual([{ type: 'playback.play', position: 30 }])
    playback({ playing: true, position: 30, updatedAt: NOW })
    vi.setSystemTime(NOW + 5_000)
    fireEvent.click(button('Pause'))
    expect(sock.sentOfType('playback.pause')).toEqual([{ type: 'playback.pause', position: 35 }])
  })

  it('play at the end of the video starts again from the beginning', () => {
    act(() => usePlayerStore.setState({ duration: 100 }))
    playback({ playing: true, position: 95, updatedAt: NOW - 10_000 })
    fireEvent.click(button('Play'))
    expect(sock.sentOfType('playback.play')).toEqual([{ type: 'playback.play', position: 0 }])
  })

  it("the seek bar sends one seek, on the input's change event", () => {
    act(() => usePlayerStore.setState({ duration: 300 }))
    playback({ position: 10 })
    const seek = screen.getByRole('slider', { name: 'Seek' })
    // Dragging fires input events, which only move the bar and the time.
    fireEvent.input(seek, { target: { value: '120' } })
    fireEvent.input(seek, { target: { value: '150' } })
    fireEvent.pointerUp(seek)
    fireEvent.keyUp(seek, { key: 'ArrowRight' })
    fireEvent.blur(seek)
    expect(sock.sentOfType('playback.seek')).toEqual([])
    expect(screen.getByText('2:30 / 5:00')).toBeTruthy()
    // Releasing it, or each key step, fires change once.
    fireEvent.change(seek)
    expect(sock.sentOfType('playback.seek')).toEqual([{ type: 'playback.seek', position: 150 }])
    fireEvent.change(seek) // nothing new to send
    expect(sock.sentOfType('playback.seek')).toHaveLength(1)
  })

  it('a connection drop mid-drag drops the scrub, so it is never sent', () => {
    act(() => usePlayerStore.setState({ duration: 300 }))
    playback({ position: 10 })
    const seek = screen.getByRole('slider', { name: 'Seek' })
    fireEvent.input(seek, { target: { value: '150' } })
    act(() => sock.serverClose(1006))
    expect(screen.getByText('0:10 / 5:00')).toBeTruthy() // back to the room's time
    fireEvent.change(seek)
    expect(sock.sentOfType('playback.seek')).toEqual([])
  })

  it('a new video mid-drag drops the scrub, so the time never sticks', () => {
    act(() => usePlayerStore.setState({ duration: 300 }))
    playback({ position: 10 })
    const seek = screen.getByRole('slider', { name: 'Seek' })
    fireEvent.input(seek, { target: { value: '150' } })
    playback({ videoId: 'aaaaaaaaaaa', position: 0 })
    act(() => usePlayerStore.setState({ duration: 0 })) // what PlaybackSync does for a new video
    act(() => usePlayerStore.setState({ duration: 200 }))
    expect(screen.getByText('0:00 / 3:20')).toBeTruthy()
    fireEvent.change(seek)
    expect(sock.sentOfType('playback.seek')).toEqual([])
  })

  it("shows the room's time, ticking while playing", async () => {
    act(() => usePlayerStore.setState({ duration: 600 }))
    playback({ playing: true, position: 61, updatedAt: NOW })
    expect(screen.getByText('1:01 / 10:00')).toBeTruthy()
    vi.setSystemTime(NOW + 10_000)
    expect(await screen.findByText('1:11 / 10:00')).toBeTruthy()
  })

  it('disables playback until a video is loaded, and everything while reconnecting', () => {
    expect(button('Play').disabled).toBe(true)
    expect((screen.getByRole('slider', { name: 'Seek' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: 'YouTube link' }) as HTMLInputElement).disabled).toBe(false)
    act(() => sock.serverClose(1006))
    expect((screen.getByRole('textbox', { name: 'YouTube link' }) as HTMLInputElement).disabled).toBe(true)
    expect(button('Load').disabled).toBe(true)
  })

  it('the volume slider sets the movie volume', () => {
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '40' } })
    expect(usePlayerStore.getState().volume).toBe(40)
  })
})
