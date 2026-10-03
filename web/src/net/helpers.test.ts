import { describe, expect, it } from 'vitest'
import { backoffDelay } from './backoff'
import { bestOffset, sampleFromPong } from './clock'
import { randomId } from './ids'
import { roomSocketUrl } from './url'

describe('backoffDelay', () => {
  it('doubles from 0.5s and caps at 8s', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000])
  })
})

describe('clock offset', () => {
  it('assumes the reply took half the round trip', () => {
    // Sent at 1000, answered at 1100: the server stamped it at about 1050
    // local time, and it said 6050, so the server is 5000ms ahead.
    expect(sampleFromPong(1000, 1100, 6050)).toEqual({ rtt: 100, offset: 5000 })
  })

  it('handles a server clock that is behind', () => {
    expect(sampleFromPong(1000, 1020, 10)).toEqual({ rtt: 20, offset: -1000 })
  })

  it('keeps the sample with the shortest round trip', () => {
    const samples = [
      { rtt: 120, offset: 5040 },
      { rtt: 20, offset: 5001 },
      { rtt: 300, offset: 4900 },
      { rtt: 20, offset: 5003 },
    ]
    expect(bestOffset(samples)).toBe(5001)
  })

  it('has no offset without samples', () => {
    expect(bestOffset([])).toBeNull()
  })
})

describe('randomId', () => {
  it('is URL-safe, 16 characters, and different each time', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()))
    expect(ids.size).toBe(100)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })
})

describe('roomSocketUrl', () => {
  it('uses ws on http and wss on https, on the page host', () => {
    expect(roomSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, 'abc')).toBe('ws://localhost:5173/ws?room=abc')
    expect(roomSocketUrl({ protocol: 'https:', host: 'popcorn.fly.dev' }, 'abc')).toBe('wss://popcorn.fly.dev/ws?room=abc')
  })

  it('escapes the room ID', () => {
    expect(roomSocketUrl({ protocol: 'http:', host: 'h' }, 'a&b')).toBe('ws://h/ws?room=a%26b')
  })
})
