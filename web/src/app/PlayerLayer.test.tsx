// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakePlayer } from '../player/fakePlayer'
import { PlayerState } from '../player/player'
import { initialPlayerFacts, usePlayerStore } from '../player/store'
import type { PlaybackState, ServerMessage } from '../protocol/schemas'
import { welcome } from '../test/fakeSocket'
import { PlayerLayer, type CreatePlayer } from './PlayerLayer'
import { applyServerMessage } from './roomState'
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
    expect(screen.getByText('Your browser blocked the video from playing.')).toBeTruthy()
    expect(container.querySelector('.player-layer.clickable')).not.toBeNull()

    player.blockAutoplay(false)
    fireEvent.click(screen.getByRole('button', { name: 'Start video' }))
    expect(player.getState()).toBe(PlayerState.Playing)
    expect(screen.queryByRole('button', { name: 'Start video' })).toBeNull()
  })
})
