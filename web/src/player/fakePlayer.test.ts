import { beforeEach, describe, expect, it } from 'vitest'
import { FakePlayer } from './fakePlayer'
import { PlayerState } from './player'

const ID = 'dQw4w9WgXcQ'
let now = 0
const make = () => new FakePlayer({ videoDuration: 100, now: () => now })

beforeEach(() => {
  now = 0
})

describe('FakePlayer', () => {
  it('cues without playing; once playing, time follows the clock and the duration is known', () => {
    const p = make()
    p.load(ID, 10)
    expect([p.getState(), p.getCurrentTime(), p.getDuration()]).toEqual([PlayerState.Cued, 10, 0])
    now += 5_000
    expect(p.getCurrentTime()).toBe(10)
    p.play()
    now += 2_000
    expect([p.getState(), p.getCurrentTime(), p.getDuration()]).toEqual([PlayerState.Playing, 12, 100])
    expect(p.calls).toEqual([`load:${ID}@10`, 'play'])
  })

  it('pause freezes the time, and a seek while paused stays paused', () => {
    const p = make()
    p.load(ID)
    p.play()
    now += 3_000
    p.pause()
    now += 3_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Paused, 3])
    p.seek(50)
    now += 1_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Paused, 50])
  })

  it('seeking a cued video starts it playing, like YouTube', () => {
    const p = make()
    const states: number[] = []
    p.onStateChange((s) => states.push(s))
    p.load(ID)
    p.seek(20)
    now += 1_000
    expect(states).toEqual([PlayerState.Cued, PlayerState.Playing])
    expect(p.getCurrentTime()).toBe(21)
  })

  it('stall() stops the time while it still says playing; skew() nudges it', () => {
    const p = make()
    p.load(ID)
    p.play()
    now += 1_000
    p.stall()
    now += 5_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Playing, 1])
    p.unstall()
    now += 1_000
    expect(p.getCurrentTime()).toBe(2)
    p.skew(-0.5)
    expect(p.getCurrentTime()).toBe(1.5)
  })

  it('ends at the duration, and play() after the end starts over', () => {
    const p = make()
    p.load(ID, 95)
    p.play()
    now += 10_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Ended, 100])
    p.play()
    now += 1_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Playing, 1])
  })

  it('blocked autoplay: play() reports it and does nothing; fail() reports an error', () => {
    const p = make()
    let blocked = 0
    const errors: number[] = []
    p.onAutoplayBlocked(() => blocked++)
    p.onError((code) => errors.push(code))
    p.blockAutoplay()
    p.load(ID)
    p.play()
    expect([blocked, p.getState()]).toEqual([1, PlayerState.Cued])
    p.fail(150)
    expect(errors).toEqual([150])
  })

  it('reports Ended as an event, and play() after the end starts over without polling first', () => {
    const p = make()
    const states: number[] = []
    p.onStateChange((s) => states.push(s))
    p.load(ID, 95)
    p.play()
    now += 10_000
    p.play()
    expect(states).toEqual([PlayerState.Cued, PlayerState.Playing, PlayerState.Ended, PlayerState.Playing])
    now += 1_000
    expect(p.getCurrentTime()).toBe(1)
  })
})
