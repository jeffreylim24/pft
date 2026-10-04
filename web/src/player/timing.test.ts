import { describe, expect, it } from 'vitest'
import { clampToDuration, driftTarget, expectedPosition, formatTime } from './timing'

const pb = (playing: boolean, position: number, updatedAt: number) => ({ playing, position, updatedAt })

describe('expectedPosition', () => {
  it('holds still while paused', () => {
    expect(expectedPosition(pb(false, 42, 1_000), 99_000)).toBe(42)
  })

  it('moves with the server clock while playing', () => {
    expect(expectedPosition(pb(true, 42, 1_000), 3_500)).toBe(44.5)
  })

  it('never runs backwards when the clocks disagree', () => {
    expect(expectedPosition(pb(true, 42, 5_000), 4_000)).toBe(42)
  })
})

describe('clampToDuration', () => {
  it('clamps to a known duration and leaves the position alone while the duration is unknown', () => {
    expect(clampToDuration(650, 600)).toBe(600)
    expect(clampToDuration(30, 600)).toBe(30)
    expect(clampToDuration(650, 0)).toBe(650)
  })
})

describe('driftTarget', () => {
  it('leaves up to 1 s of drift alone', () => {
    expect(driftTarget(10, 11, 600)).toBeNull()
    expect(driftTarget(11, 10, 600)).toBeNull()
  })

  it('seeks to the expected position beyond 1 s', () => {
    expect(driftTarget(10, 11.5, 600)).toBe(11.5)
    expect(driftTarget(13, 11.5, 0)).toBe(11.5)
  })

  it('clamps to the duration, so a video that has ended is left alone', () => {
    expect(driftTarget(600, 640, 600)).toBeNull()
    expect(driftTarget(590, 640, 600)).toBe(600)
  })
})

describe('formatTime', () => {
  it.each<[number, string]>([
    [0, '0:00'],
    [9.9, '0:09'],
    [61, '1:01'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [-5, '0:00'],
    [Number.NaN, '0:00'],
  ])('%s s is %s', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text)
  })
})
