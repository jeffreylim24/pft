import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../protocol/schemas'
import { welcome } from '../test/fakeSocket'
import { applyServerMessage, type RoomState } from './roomState'

const sam = { id: 'p2', name: 'Sam', color: '#2e86ab', pageSession: 'ps-2' }

function start(): RoomState {
  return applyServerMessage(null, welcome('me') as ServerMessage)!
}

function apply(room: RoomState, ...msgs: unknown[]): RoomState {
  return msgs.reduce<RoomState>((r, m) => applyServerMessage(r, m as ServerMessage)!, room)
}

describe('applyServerMessage', () => {
  it('builds the room from welcome', () => {
    const room = start()
    expect(room.you).toBe('me')
    expect(room.polite).toBe(false)
    expect(room.participants.map((p) => p.id)).toEqual(['me'])
    expect(room.playback.videoId).toBeNull()
    expect(Object.keys(room.cams)).toEqual(['me'])
  })

  it('ignores everything before the first welcome', () => {
    expect(applyServerMessage(null, { type: 'participant.joined', participant: sam })).toBeNull()
  })

  it('adds a partner who joins, with their cam', () => {
    const room = apply(start(), { type: 'participant.joined', participant: sam }, {
      type: 'cam',
      camId: 'p2',
      rect: { x: 0.76, y: 0.745, w: 0.22, h: 0.22 },
      holder: null,
    })
    expect(room.participants).toEqual([room.participants[0], { ...sam, connected: true }])
    expect(room.cams.p2.rect.x).toBe(0.76)
  })

  it('marks a partner reconnecting, then back with their new page session', () => {
    let room = apply(start(), { type: 'participant.joined', participant: sam })
    room = apply(room, { type: 'participant.reconnecting', id: 'p2' })
    expect(room.participants[1].connected).toBe(false)
    room = apply(room, { type: 'participant.joined', participant: { ...sam, pageSession: 'ps-3' } })
    expect(room.participants).toHaveLength(2)
    expect(room.participants[1]).toEqual({ ...sam, pageSession: 'ps-3', connected: true })
  })

  it('removes a partner who leaves, and their cam', () => {
    const room = apply(
      start(),
      { type: 'participant.joined', participant: sam },
      { type: 'cam', camId: 'p2', rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, holder: null },
      { type: 'participant.left', id: 'p2' },
    )
    expect(room.participants.map((p) => p.id)).toEqual(['me'])
    expect(room.cams.p2).toBeUndefined()
  })

  it('replaces playback and cam state with the broadcast', () => {
    const state = { videoId: 'dQw4w9WgXcQ', playing: true, position: 3, updatedAt: 1, waitingFor: null, autoResume: false }
    const room = apply(
      start(),
      { type: 'playback', state },
      { type: 'cam', camId: 'me', rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, holder: 'p2' },
    )
    expect(room.playback).toEqual(state)
    expect(room.cams.me).toEqual({ rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, holder: 'p2' })
  })

  it('empties sticky ink on ink.clear', () => {
    const w = welcome('me') as ServerMessage & { type: 'welcome' }
    w.snapshot.stickyStrokes = [{ id: 's1', author: 'me', color: '#e4572e', width: 0.004, points: [[0.1, 0.1]] }]
    const room = apply(applyServerMessage(null, w)!, { type: 'ink.clear', from: 'p2' })
    expect(room.stickyStrokes).toEqual([])
  })

  it('a later welcome (a resume) replaces the whole room', () => {
    const room = apply(start(), { type: 'participant.joined', participant: sam })
    const resumed = apply(room, welcome('me'))
    expect(resumed.participants.map((p) => p.id)).toEqual(['me'])
  })

  it('returns the same object for messages that are not room state', () => {
    const room = start()
    for (const msg of [
      { type: 'pong', t0: 1, serverTime: 2 },
      { type: 'cursor', from: 'p2', x: 0.5, y: 0.5 },
      { type: 'cursor.hide', from: 'p2' },
      { type: 'ink.end', from: 'p2', strokeId: 's1' },
      { type: 'signal', from: 'p2', data: { candidate: {} } },
      { type: 'error', code: 'rate_limited', message: 'slow down' },
    ]) {
      expect(applyServerMessage(room, msg as ServerMessage)).toBe(room)
    }
  })

  it('does not modify the previous state', () => {
    const room = start()
    const before = structuredClone(room)
    apply(room, { type: 'participant.joined', participant: sam }, { type: 'participant.left', id: 'me' })
    expect(room).toEqual(before)
  })
})
