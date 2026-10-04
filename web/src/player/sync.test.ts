import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { FakePlayer, type FakePlayerOptions } from './fakePlayer'
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

function start(opts: FakePlayerOptions = {}, Kind: typeof FakePlayer = FakePlayer) {
  sync?.destroy()
  player = new Kind({ videoDuration: 600, ...opts })
  sent = []
  sync = new PlaybackSync({
    player,
    send: (msg) => {
      sent.push(msg)
      return true
    },
    serverNow,
  })
}

/** A player whose time reads ahead while it says Playing, like YouTube's widget. */
const ESTIMATING = { estimateAhead: { updateMs: 500 } }

/**
 * Like YouTube's widget, seekTo is only a message to the iframe: until its
 * next report, about 300 ms later, the reading still comes from before the seek.
 */
class LaggingPlayer extends FakePlayer {
  private stale: { from: number; at: number } | null = null

  override seek(seconds: number): void {
    const from = this.getCurrentTime()
    super.seek(seconds)
    this.stale = { from, at: Date.now() }
  }

  override getCurrentTime(): number {
    const stale = this.stale
    if (stale && Date.now() - stale.at < 300) return stale.from
    return super.getCurrentTime()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  usePlayerStore.setState(initialPlayerFacts)
  start()
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

  it("doesn't restart a video that ended just before the room's end", () => {
    apply(state({ playing: true, position: 590 }))
    player.skew(0.5) // this player runs half a second ahead
    vi.advanceTimersByTime(9_600)
    expect(player.getState()).toBe(PlayerState.Ended) // the room expects 599.6
    apply(state({ playing: true, position: 599.6 })) // a new state, e.g. a welcome
    expect(player.calls.filter((c) => c === 'play')).toEqual(['play']) // only the first one
    expect(player.getState()).toBe(PlayerState.Ended)
  })

  it('pauses while disconnected, and catches up when the welcome arrives', () => {
    const playing = state({ playing: true })
    apply(playing)
    vi.advanceTimersByTime(3_000)
    apply(playing, false)
    expect(player.getState()).toBe(PlayerState.Paused)
    vi.advanceTimersByTime(5_000)
    // The status turns open just before the welcome. The old state is stale, so nothing happens.
    apply(playing, true)
    expect(player.calls).toEqual([`load:${VIDEO}@0`, 'play', 'pause'])
    apply({ ...playing }) // the welcome's snapshot is a new object
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

  const players: Array<[string, FakePlayerOptions, typeof FakePlayer]> = [
    ['player', {}, FakePlayer],
    ['player that estimates ahead', ESTIMATING, FakePlayer],
  ]
  // Recovery's own seek happens after the ad, and only delays ready, so the
  // lagging player is for the stall and seek tests.
  const seekingPlayers = [...players, ['player that estimates ahead and reads late after a seek', ESTIMATING, LaggingPlayer] as const]

  it.each(seekingPlayers)('reports a stall once when the %s stops moving for over 2 s', (_, opts, Kind) => {
    start(opts, Kind)
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

  it.each(players)('after its own stall (%s): keeps playing until the video moves, then pauses at the room position and sends ready', (_, opts, Kind) => {
    start(opts, Kind)
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
    vi.advanceTimersByTime(1_500)
    expect(types()).toEqual(['playback.stalled']) // 1.5 s of progress isn't enough yet
    vi.advanceTimersByTime(500)
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

  it.each(players)('after a reload (%s), a snapshot waiting for me: loads, plays until the video moves, pauses at the position, sends ready', (_, opts, Kind) => {
    start(opts, Kind)
    apply(state({ position: 120, waitingFor: 'me', autoResume: true }))
    vi.advanceTimersByTime(1_500)
    expect(types()).toEqual([])
    vi.advanceTimersByTime(500)
    expect(player.calls).toEqual([`load:${VIDEO}@120`, 'play', 'pause', 'seek:120'])
    expect(types()).toEqual(['playback.ready'])
  })

  it.each(seekingPlayers)('no stall after a seek back while playing, with a %s', (_, opts, Kind) => {
    start(opts, Kind)
    apply(state({ playing: true, position: 300 }))
    vi.advanceTimersByTime(3_000)
    apply(state({ playing: true, position: 240 })) // someone seeks back a minute
    vi.advanceTimersByTime(5_000)
    expect(types()).toEqual([])
    expect(player.getCurrentTime()).toBe(245)
  })

  it("a jump in the player's time isn't progress, so a stuck player still stalls", () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(1_000)
    player.stall()
    vi.advanceTimersByTime(1_000)
    player.skew(5) // e.g. a cued start arriving late; the video still isn't moving
    vi.advanceTimersByTime(1_500)
    expect(types()).toEqual(['playback.stalled'])
  })

  it("a stuck player whose reading runs a full second ahead isn't playable", () => {
    start({ estimateAhead: { updateMs: 10_000 } }) // no update arrives while the video is stuck
    apply(state({ position: 30, waitingFor: 'me', autoResume: true }))
    player.stall() // an ad
    vi.advanceTimersByTime(5_000)
    expect(player.getCurrentTime()).toBe(31) // the reading is 1 s ahead
    expect(types()).toEqual([])
  })

  it('a step counts for no more than the time that passed', () => {
    apply(state({ position: 30, waitingFor: 'me', autoResume: true }))
    player.stall() // an ad
    vi.advanceTimersByTime(1_000)
    player.skew(1.6) // too small to be a jump, too big to be 250 ms of playback
    vi.advanceTimersByTime(2_000)
    expect(types()).toEqual([])
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
    vi.advanceTimersByTime(2_000)
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
    vi.advanceTimersByTime(2_000)
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:2.25'])
    expect(types()).toEqual(['playback.stalled', 'playback.ready'])
  })

  it('after the end, a reconnect waiting for me sends ready without restarting the video', () => {
    const playing = state({ playing: true, position: 595 })
    apply(playing)
    vi.advanceTimersByTime(10_000)
    expect(player.getState()).toBe(PlayerState.Ended)
    apply(playing, false)
    apply(state({ position: 605, waitingFor: 'me', autoResume: true }))
    vi.advanceTimersByTime(1_000)
    expect(player.calls.filter((c) => c === 'play')).toEqual(['play']) // only the first one
    expect(player.getState()).toBe(PlayerState.Ended)
    expect(types()).toEqual(['playback.ready'])
  })

  it('recovers when the player reaches the end before the room position', () => {
    const playing = state({ playing: true, position: 599.1 })
    apply(playing)
    vi.advanceTimersByTime(500) // the player is at 599.6
    apply(playing, false)
    apply(state({ position: 599, waitingFor: 'me', autoResume: true })) // resumes at 599.6 and ends within half a second
    vi.advanceTimersByTime(1_000)
    expect([player.getState(), player.getCurrentTime()]).toEqual([PlayerState.Paused, 599])
    expect(types()).toEqual(['playback.ready'])
  })

  it("a player error during recovery sends ready, so the partner isn't held", () => {
    apply(state({ position: 30, waitingFor: 'me', autoResume: true }))
    player.stall()
    player.fail(150)
    vi.advanceTimersByTime(500)
    expect(types()).toEqual(['playback.ready'])
  })
})
