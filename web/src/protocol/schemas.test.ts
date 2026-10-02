import { describe, expect, it } from 'vitest'
import { clientMessage } from './schemas'

const hello = { type: 'hello', name: 'Alex', color: '#e4572e', pageSession: 'ps-1' }
const pts = (n: number) => Array.from({ length: n }, () => [0.1, 0.1])
const ink = { type: 'ink.points', strokeId: 's', mode: 'fading', color: '#000000', width: 0.004 }

// The same rules as server/internal/protocol/validate_test.go, so the client
// catches its own mistakes instead of getting bad_message back.
describe('client messages the server would reject', () => {
  it.each([
    ['blank name', { ...hello, name: '   ' }],
    ['33-character name', { ...hello, name: 'a'.repeat(33) }],
    ['named color', { ...hello, color: 'red' }],
    ['missing pageSession', { type: 'hello', name: 'A', color: '#112233' }],
    ['65-character resume token', { ...hello, resumeToken: 't'.repeat(65) }],
    ['short video id', { type: 'playback.load', videoId: 'short' }],
    ['video id with a slash', { type: 'playback.load', videoId: 'abc/defghij' }],
    ['position as a string', { type: 'playback.play', position: 'ten' }],
    ['empty cam id', { type: 'cam.grab', camId: '' }],
    ['cam.move without rect', { type: 'cam.move', camId: 'c' }],
    ['unknown ink mode', { ...ink, mode: 'glitter', points: pts(1) }],
    ['empty ink batch', { ...ink, points: [] }],
    ['65-point ink batch', { ...ink, points: pts(65) }],
    ['signal without data', { type: 'signal' }],
    ['unknown type', { type: 'dance' }],
  ])('rejects %s', (_, msg) => {
    expect(clientMessage.safeParse(msg).success).toBe(false)
  })
})

describe('client messages at the limits', () => {
  it.each([
    // 32 emoji are 64 UTF-16 units but 32 code points, and Go counts runes.
    ['32-emoji name', { ...hello, name: '🍿'.repeat(32) }],
    ['name with surrounding spaces', { ...hello, name: '  Alex  ' }],
    ['64-point ink batch', { ...ink, points: pts(64) }],
  ])('accepts %s', (_, msg) => {
    expect(clientMessage.safeParse(msg).success).toBe(true)
  })
})
