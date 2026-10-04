import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { FakePlayer } from './fakePlayer'
import { PlayerState } from './player'
import { initialPlayerFacts, setMovieVolume, usePlayerStore } from './store'
import { PlaybackSync } from './sync'

const VIDEO = 'dQw4w9WgXcQ'
const OFFSET = 5_000 // the server's clock runs 5 s ahead of ours
let player: FakePlayer
let sent: ClientMessage[]
let sync: PlaybackSync

const serverNow = () => Date.now() + OFFSET

/** A playback state stamped with the current server time. */
function state(changes: Partial<PlaybackState> = {}): PlaybackState {
  return {
    videoId: VIDEO,
    playing: false,
    position: 0,
    updatedAt: serverNow(),
    waitingFor: null,
    autoResume: false,
    ...changes,
  }
}

function apply(playback: PlaybackState, connected = true) {
  sync.update({ playback, you: 'me', connected })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  usePlayerStore.setState(initialPlayerFacts)
  player = new FakePlayer({ videoDuration: 600 })
  sent = []
  sync = new PlaybackSync({
    player,
    send: (msg) => {
      sent.push(msg)
      return true
    },
    serverNow,
  })
})

afterEach(() => {
  sync.destroy()
  vi.useRealTimers()
})

describe('PlaybackSync: following the room', () => {
  it('cues the room video at its paused position without playing it', () => {
    apply(state({ position: 42 }))
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause'])
    expect(player.getState()).toBe(PlayerState.Cued)
  })

  it('joins a playing room at the expected position, using the server clock', () => {
    apply(state({ playing: true, position: 10, updatedAt: serverNow() - 3_000 }))
    expect(player.calls).toEqual([`load:${VIDEO}@13`, 'play'])
    expect(player.getState()).toBe(PlayerState.Playing)
  })

  it('plays and pauses only when the broadcast says so', () => {
    apply(state())
    apply(state({ playing: true }))
    vi.advanceTimersByTime(5_000)
    apply(state({ position: 5 }))
    expect(player.calls).toEqual([`load:${VIDEO}@0`, 'pause', 'play', 'pause'])
    expect([player.getState(), player.getCurrentTime()]).toEqual([PlayerState.Paused, 5])
  })

  it('seeks when a seek arrives, while playing or paused', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(5_000)
    apply(state({ playing: true, position: 60 }))
    expect(player.calls).toEqual([`load:${VIDEO}@0`, 'play', 'seek:60', 'play'])
    apply(state({ position: 30 }))
    expect(player.calls.slice(4)).toEqual(['pause', 'seek:30'])
    expect([player.getState(), player.getCurrentTime()]).toEqual([PlayerState.Paused, 30])
  })

  it("cues again instead of seeking a video that hasn't started", () => {
    apply(state({ position: 42 }))
    apply(state({ position: 100 }))
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause', 'pause', `load:${VIDEO}@100`])
    expect(player.getState()).toBe(PlayerState.Cued)
  })

  it('corrects drift over 1 s every 2 s, but not within 3 s of a seek or load', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(2_500) // the check at 2 s is within 3 s of the load
    player.skew(-1.5)
    vi.advanceTimersByTime(1_500) // the check at 4 s finds the player 1.5 s behind
    expect(player.calls.filter((c) => c.startsWith('seek'))).toEqual(['seek:4'])
    player.skew(-0.8)
    vi.advanceTimersByTime(4_000) // 6 s is too soon after that seek; at 8 s, 0.8 s is fine
    expect(player.calls.filter((c) => c.startsWith('seek'))).toEqual(['seek:4'])
  })

  it('pauses a player that starts by itself while the room is paused', () => {
    apply(state({ position: 42 }))
    player.play() // e.g. a click on the video, or YouTube playing a seeked cued video
    expect(player.getState()).toBe(PlayerState.Paused)
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause', 'play', 'pause'])
  })

  it('at the end of the video: no restart and no drift seeks', () => {
    const startedAt = serverNow()
    apply(state({ playing: true, position: 590, updatedAt: startedAt }))
    vi.advanceTimersByTime(15_000)
    expect(player.getState()).toBe(PlayerState.Ended)
    // The same state again (a reconnect, say) must not call play(): YouTube would start over.
    apply(state({ playing: true, position: 590, updatedAt: startedAt }))
    expect(player.calls).toEqual([`load:${VIDEO}@590`, 'play'])
  })

  it('pauses while disconnected, and catches up on reconnect', () => {
    const playing = state({ playing: true })
    apply(playing)
    vi.advanceTimersByTime(3_000)
    apply(playing, false)
    expect(player.getState()).toBe(PlayerState.Paused)
    vi.advanceTimersByTime(5_000)
    apply(playing, true)
    expect(player.calls).toEqual([`load:${VIDEO}@0`, 'play', 'pause', 'seek:8', 'play'])
  })

  it('ignores updates that leave playback unchanged', () => {
    const paused = state({ position: 42 })
    apply(paused)
    apply(paused)
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause'])
  })

  it('applies the volume slider to the player', () => {
    setMovieVolume(30)
    expect(player.volume).toBe(30)
    setMovieVolume(150)
    expect(player.volume).toBe(100)
  })
})

describe('PlaybackSync: stalls and getting ready', () => {
  const types = () => sent.map((m) => m.type)

  it('reports a stall once when the player stops moving for over 2 s', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(1_000)
    player.stall()
    vi.advanceTimersByTime(2_000)
    expect(types()).toEqual([])
    vi.advanceTimersByTime(500)
    expect(types()).toEqual(['playback.stalled'])
    vi.advanceTimersByTime(5_000)
    expect(types()).toEqual(['playback.stalled'])
  })

  it("doesn't report a stall while the room is paused", () => {
    apply(state({ position: 10 }))
    vi.advanceTimersByTime(5_000)
    expect(types()).toEqual([])
  })

  it("doesn't report a stall after a player error", () => {
    apply(state({ playing: true }))
    player.fail(150)
    player.stall()
    vi.advanceTimersByTime(5_000)
    expect(usePlayerStore.getState().error).toBe(150)
    expect(types()).toEqual([])
  })

  it("doesn't report a stall at the end of the video", () => {
    apply(state({ playing: true, position: 595 }))
    vi.advanceTimersByTime(10_000)
    expect(player.getState()).toBe(PlayerState.Ended)
    expect(types()).toEqual([])
  })

  it('after its own stall: keeps playing until the video moves, then pauses at the room position and sends ready', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(1_000)
    player.stall() // an ad starts
    vi.advanceTimersByTime(2_500)
    expect(types()).toEqual(['playback.stalled'])

    apply(state({ position: 3.25, waitingFor: 'me', autoResume: true })) // the server pauses the room for us
    vi.advanceTimersByTime(3_000)
    expect(player.getState()).toBe(PlayerState.Playing) // still in the ad, not paused
    expect(types()).toEqual(['playback.stalled'])

    player.unstall() // the ad ends and the video moves again
    vi.advanceTimersByTime(1_000)
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:3.25'])
    expect([player.getState(), player.getCurrentTime()]).toEqual([PlayerState.Paused, 3.25])
    expect(types()).toEqual(['playback.stalled', 'playback.ready'])

    apply(state({ playing: true, position: 3.25 })) // the server resumes
    expect(player.getState()).toBe(PlayerState.Playing)
  })

  it('waiting for the partner: pauses at the room position and sends nothing', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(3_000)
    apply(state({ position: 2.5, waitingFor: 'p2', autoResume: true }))
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:2.5'])
    vi.advanceTimersByTime(5_000)
    expect(types()).toEqual([])
  })

  it('after a reload, a snapshot waiting for me: loads, plays until the video moves, pauses at the position, sends ready', () => {
    apply(state({ position: 120, waitingFor: 'me', autoResume: true }))
    vi.advanceTimersByTime(1_000)
    expect(player.calls).toEqual([`load:${VIDEO}@120`, 'play', 'pause', 'seek:120'])
    expect(types()).toEqual(['playback.ready'])
  })

  it('recovers when the room is waiting past the end of the video', () => {
    apply(state({ position: 650, waitingFor: 'me', autoResume: true }))
    vi.advanceTimersByTime(1_000)
    expect(player.getState()).toBe(PlayerState.Ended)
    expect(types()).toEqual(['playback.ready'])
  })

  it('sends nothing while disconnected, and recovers after reconnecting', () => {
    const waiting = state({ position: 30, waitingFor: 'me', autoResume: true })
    apply(waiting)
    apply(waiting, false)
    vi.advanceTimersByTime(3_000)
    expect(types()).toEqual([])
    apply({ ...waiting }, true) // the welcome after reconnecting carries the same state
    vi.advanceTimersByTime(1_000)
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:30'])
    expect(types()).toEqual(['playback.ready'])
  })

  it('reports player errors, and clears them when a new video loads', () => {
    apply(state())
    player.fail(150)
    expect(usePlayerStore.getState().error).toBe(150)
    apply(state({ videoId: 'aaaaaaaaaaa' }))
    expect(usePlayerStore.getState().error).toBeNull()
    expect(player.calls.at(-2)).toBe('load:aaaaaaaaaaa@0')
  })

  it('blocked autoplay: flags it, and recovers once a click starts the video', () => {
    player.blockAutoplay()
    apply(state({ playing: true }))
    expect(usePlayerStore.getState().autoplayBlocked).toBe(true)
    vi.advanceTimersByTime(2_500)
    expect(types()).toEqual(['playback.stalled']) // the room waits for us

    apply(state({ position: 2.25, waitingFor: 'me', autoResume: true }))
    player.blockAutoplay(false)
    player.play() // the person clicks Start video
    expect(usePlayerStore.getState().autoplayBlocked).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:2.25'])
    expect(types()).toEqual(['playback.stalled', 'playback.ready'])
  })
})
