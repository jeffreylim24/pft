// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '../protocol/schemas'
import { welcome } from '../test/fakeSocket'
import { applyServerMessage } from './roomState'
import { RoomRoute } from './RoomRoute'
import { initialAppState, useAppStore, type SessionStatus } from './store'

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'
const room = applyServerMessage(null, welcome('me') as ServerMessage)!
const partner = { id: 'p2', name: 'Sam', color: '#2e86ab', pageSession: 'ps-2' }

function show(status: SessionStatus, withRoom = true) {
  useAppStore.setState({ roomId, status, room: withRoom ? room : null })
  render(<RoomRoute roomId={roomId} />)
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState)
})

describe('RoomRoute', () => {
  it('shows the lobby before joining', () => {
    useAppStore.setState(initialAppState)
    render(<RoomRoute roomId={roomId} />)
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy()
  })

  it('keeps the lobby busy until the first welcome, even while retrying', () => {
    show({ kind: 'reconnecting', attempt: 2 }, false)
    expect(screen.getByRole('button', { name: 'Joining…' })).toBeTruthy()
  })

  it('shows the room once joined, waiting for the partner', () => {
    show({ kind: 'open' })
    expect(screen.getByRole('button', { name: 'Leave' })).toBeTruthy()
    expect(screen.getByText("Waiting for your partner. Send them this room's link.")).toBeTruthy()
  })

  it('says when the partner is reconnecting', () => {
    useAppStore.setState({
      roomId,
      status: { kind: 'open' },
      room: { ...room, participants: [...room.participants, { ...partner, connected: false }] },
    })
    render(<RoomRoute roomId={roomId} />)
    expect(screen.getByText('Sam is reconnecting…')).toBeTruthy()
  })

  it('shows a banner while reconnecting', () => {
    show({ kind: 'reconnecting', attempt: 1 })
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
  })

  it.each([
    ['room_full', 'This room is full'],
    ['not_found', 'Room not found'],
    ['replaced', "You're in this room in another tab"],
    ['rejected', "Couldn't join the room"],
  ] as const)('shows the %s page', (reason, title) => {
    show({ kind: 'closed', reason }, false)
    expect(screen.getByRole('heading').textContent).toBe(title)
  })

  it('room full offers Try again, since your own seat may still be held', () => {
    show({ kind: 'closed', reason: 'room_full' }, false)
    expect(screen.getByText(/your seat is held for 30 seconds/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create room' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('button', { name: /Join|Rejoin/ })).toBeTruthy()
  })

  it('"Use this tab instead" goes back to the lobby', () => {
    show({ kind: 'closed', reason: 'replaced' })
    fireEvent.click(screen.getByRole('button', { name: 'Use this tab instead' }))
    expect(screen.getByRole('button', { name: /Join|Rejoin/ })).toBeTruthy()
  })

  it('treats a session for another room as not joined', () => {
    useAppStore.setState({ roomId: 'AAAAAAAAAAAAAAAAAAAAAA', status: { kind: 'open' }, room })
    render(<RoomRoute roomId={roomId} />)
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy()
  })
})
