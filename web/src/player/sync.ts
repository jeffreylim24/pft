// Keeps this browser's player in step with the room (spec section 7). It
// follows only the server's broadcast state, never a person's command, so
// both browsers act on the same thing. It also corrects drift, reports
// stalls, and gets the player ready when the room is waiting for us.
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { API_LOAD_FAILED, PlayerState, type Player, type PlayerStateValue } from './player'
import { usePlayerStore } from './store'
import { clampToDuration, DRIFT_LIMIT_S, driftTarget, expectedPosition } from './timing'

/** How often the player is sampled for progress, stalls and recovery. */
export const TICK_MS = 250
export const DRIFT_CHECK_MS = 2_000
/** No drift seeks this soon after our own load or seek. */
export const SEEK_GRACE_MS = 3_000
/** A playing room whose player hasn't moved for longer than this is stalled. */
export const STALL_MS = 2_000
/** How far a paused player may sit from the room position. */
export const PAUSED_TOLERANCE_S = 0.25
/** How close a recovering player must be to the room position to say ready. */
export const READY_TOLERANCE_S = 0.5
/**
 * Seconds a recovering player must really move before it counts as playable.
 * YouTube's getCurrentTime() runs up to 1 s ahead of the player while it
 * says Playing, even when the video is stuck behind an ad, so this is more.
 */
export const RECOVERY_PROGRESS_S = 1.5
/** Smaller changes in the player's time don't count as moving. */
const MOVED_S = 0.05
/** A step forward this much more than the time that passed is a jump, not playback. */
const JUMP_S = 2
/**
 * A reading this far below the high-water mark means the video went back,
 * not that the estimate snapped back: YouTube's reading runs at most 1 s ahead.
 * It stays under STALL_MS, so a smaller step back is passed again in time.
 */
const DROP_S = 1.5

export interface SyncInput {
  playback: PlaybackState
  you: string
  connected: boolean
}

export interface PlaybackSyncDeps {
  player: Player
  send: (msg: ClientMessage) => boolean
  serverNow: () => number
}

// When the room is auto-paused waiting for this browser: awaitingProgress
// lets the player run until the video itself moves (an ad or buffering is
// over), settling pauses and seeks to the room position, and readySent
// means playback.ready went out.
type Recovery = 'none' | 'awaitingProgress' | 'settling' | 'readySent'

export class PlaybackSync {
  private readonly player: Player
  private readonly send: (msg: ClientMessage) => boolean
  private readonly serverNow: () => number
  private readonly cleanups: Array<() => void> = []
  private input: SyncInput | null = null
  private loadedVideoId: string | null = null
  private lastSeekAt = -Infinity // local ms of our last load or seek
  // Progress is measured from a high-water mark, because YouTube's reading
  // can creep ahead and snap back while the video isn't moving at all.
  private highWater = 0 // the furthest the player's time has moved since our last apply, cue or seek
  private sampledAt = 0 // local ms of the last reading
  private lastProgressAt = 0 // local ms when the player's time last moved
  private recoveryProgress = 0 // seconds the video has moved since recovery began
  private stalledSent = false
  private recovery: Recovery = 'none'

  constructor({ player, send, serverNow }: PlaybackSyncDeps) {
    this.player = player
    this.send = send
    this.serverNow = serverNow
    usePlayerStore.setState({ duration: 0, error: null, autoplayBlocked: false })
    player.setVolume(usePlayerStore.getState().volume)
    const tick = setInterval(() => this.tick(), TICK_MS)
    const drift = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS)
    this.cleanups.push(
      () => clearInterval(tick),
      () => clearInterval(drift),
      player.onStateChange((state) => this.playerStateChanged(state)),
      player.onError((code) => usePlayerStore.setState({ error: code })),
      player.onAutoplayBlocked(() => usePlayerStore.setState({ autoplayBlocked: true })),
      usePlayerStore.subscribe((facts, prev) => {
        if (facts.volume !== prev.volume) player.setVolume(facts.volume)
      }),
    )
  }

  /** Called on every store change. Acts only when something relevant changed. */
  update(next: SyncInput): void {
    const prev = this.input
    this.input = next
    if (!next.connected) {
      // While we're away the server pauses the partner, so stop here too.
      if (prev?.connected !== false) this.player.pause()
      return
    }
    // The status turns open just before the welcome arrives. Until then the
    // playback is the stale one from before the drop, and the welcome always
    // brings a new object (spec 13).
    if (prev?.connected === false && prev.playback === next.playback) return
    if (!prev?.connected || prev.playback !== next.playback || prev.you !== next.you) this.apply()
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  // Makes the player match a new room state.
  private apply(): void {
    const { playback, you } = this.input!
    this.recovery = 'none'
    this.stalledSent = false
    this.recoveryProgress = 0
    if (playback.videoId === null) return
    const justLoaded = playback.videoId !== this.loadedVideoId
    if (justLoaded) {
      this.loadedVideoId = playback.videoId
      usePlayerStore.setState({ duration: 0, error: null, autoplayBlocked: false })
      this.cue(playback.videoId, expectedPosition(playback, this.serverNow()))
    }
    const target = this.target()
    this.markProgress()
    if (playback.waitingFor === you && playback.autoResume) {
      if (this.ended()) {
        this.startSettling() // play() on an ended video would start it over (spec 13)
      } else {
        // Set before play(), so the Playing event that follows isn't undone.
        this.recovery = 'awaitingProgress'
        this.player.play()
      }
    } else if (playback.playing) {
      if (!justLoaded && Math.abs(this.player.getCurrentTime() - target) > DRIFT_LIMIT_S) this.seek(target)
      // play() after the end would start the video over (spec 13). A seek
      // from Ended above starts YouTube playing by itself.
      if (!this.ended()) this.player.play()
    } else {
      this.player.pause()
      if (!justLoaded && Math.abs(this.player.getCurrentTime() - target) > PAUSED_TOLERANCE_S) {
        this.moveWhilePaused(playback.videoId, target)
      }
    }
  }

  private tick(): void {
    const duration = this.player.getDuration()
    if (duration !== usePlayerStore.getState().duration) usePlayerStore.setState({ duration })
    const input = this.input
    if (!input?.connected || input.playback.videoId === null) return
    const now = Date.now()
    const time = this.player.getCurrentTime()
    const progress = this.progressTo(time, now)
    if (progress > 0) this.lastProgressAt = now
    if (this.recovery !== 'none') {
      this.recover(time, progress)
      return
    }
    const stalled = input.playback.playing && !this.stalledSent && now - this.lastProgressAt > STALL_MS
    // At the end of the video the player stops for good. That isn't a stall (spec 13).
    if (stalled && usePlayerStore.getState().error === null && !this.ended()) {
      this.stalledSent = this.send({ type: 'playback.stalled' })
    }
  }

  // Spec 7.3, recovery: wait until the player can play again, pause and
  // seek to the room position, then say ready.
  private recover(time: number, progress: number): void {
    // A player that can't play must not hold the room.
    if (usePlayerStore.getState().error !== null) {
      if (this.recovery !== 'readySent' && this.send({ type: 'playback.ready' })) this.recovery = 'readySent'
      return
    }
    const state = this.player.getState()
    if (this.recovery === 'awaitingProgress') {
      this.recoveryProgress += progress
      const playable = state === PlayerState.Playing && this.recoveryProgress > RECOVERY_PROGRESS_S
      if (state === PlayerState.Ended || playable) this.startSettling()
      return
    }
    if (this.recovery === 'settling') {
      const still = state === PlayerState.Paused || state === PlayerState.Cued || state === PlayerState.Ended
      if (still && Math.abs(time - this.target()) <= READY_TOLERANCE_S && this.send({ type: 'playback.ready' })) {
        this.recovery = 'readySent'
      }
    }
  }

  // Pause and move to the room position. A seek from Ended starts YouTube
  // playing, but playerStateChanged pauses it again, because wantsPlaying is
  // false while settling.
  private startSettling(): void {
    this.recovery = 'settling'
    this.player.pause()
    const target = this.target()
    // An ended player already at the room position stays ended; seeking would restart it.
    const stay = this.player.getState() === PlayerState.Ended && Math.abs(this.player.getCurrentTime() - target) <= READY_TOLERANCE_S
    if (!stay) this.seek(target)
  }

  private checkDrift(): void {
    const input = this.input
    if (!input?.connected || !input.playback.playing || input.playback.videoId === null) return
    if (usePlayerStore.getState().error !== null || Date.now() - this.lastSeekAt < SEEK_GRACE_MS) return
    // Seeking a player that is buffering, or has ended, doesn't help.
    if (this.player.getState() !== PlayerState.Playing) return
    const expected = expectedPosition(input.playback, this.serverNow())
    const target = driftTarget(this.player.getCurrentTime(), expected, this.player.getDuration())
    if (target !== null) this.seek(target)
  }

  // YouTube can start playing on its own: a seek on a cued video does, and
  // so does a click while the video is clickable. Undo that if the room
  // doesn't want playback.
  private playerStateChanged(state: PlayerStateValue): void {
    if (state === PlayerState.Playing) usePlayerStore.setState({ autoplayBlocked: false })
    // A player that reports a state has loaded after all, even if it was
    // ready only after its timeout. Its first command (the cue) reports one.
    if (usePlayerStore.getState().error === API_LOAD_FAILED) usePlayerStore.setState({ error: null })
    const input = this.input
    if (!input || input.playback.videoId === null) return
    const wantsPlaying = input.connected && (input.playback.playing || this.recovery === 'awaitingProgress')
    if (!wantsPlaying && (state === PlayerState.Playing || state === PlayerState.Buffering)) this.player.pause()
  }

  // Seeking a video that hasn't started, or has ended, would start it
  // playing, so cue it again at the new spot instead.
  private moveWhilePaused(videoId: string, target: number): void {
    const state = this.player.getState()
    if (state === PlayerState.Paused || state === PlayerState.Playing || state === PlayerState.Buffering) {
      this.seek(target)
    } else {
      this.cue(videoId, target)
    }
  }

  private cue(videoId: string, start: number): void {
    this.player.load(videoId, start)
    this.lastSeekAt = Date.now()
    this.markProgress()
  }

  private seek(seconds: number): void {
    this.player.seek(seconds)
    this.lastSeekAt = Date.now()
    this.markProgress()
  }

  // A jump we caused isn't progress, and it restarts the stall clock.
  private markProgress(): void {
    this.highWater = this.player.getCurrentTime()
    this.sampledAt = this.lastProgressAt = Date.now()
  }

  // How far the video has moved since the last reading, in seconds. Only
  // time past the high-water mark counts, so a reading that runs ahead and
  // snaps back counts once. A step can't count for more than the time that
  // passed, and a much bigger one (a cued start arriving late, say) is a
  // jump: the mark moves without counting it. The mark also comes down,
  // without counting, when the reading falls well below it. YouTube's
  // seekTo is only a message to its iframe, so the reading right after our
  // own seek is still the old time, and markProgress can set the mark there.
  private progressTo(time: number, now: number): number {
    const elapsed = (now - this.sampledAt) / 1000
    this.sampledAt = now
    const step = time - this.highWater
    if (step > elapsed + JUMP_S || step < -DROP_S) {
      this.highWater = time
      return 0
    }
    if (step <= MOVED_S) return 0
    this.highWater = time
    return Math.min(step, elapsed)
  }

  /** Where the player should be now, within the video. */
  private target(): number {
    return clampToDuration(expectedPosition(this.input!.playback, this.serverNow()), this.player.getDuration())
  }

  private expectedPastEnd(): boolean {
    const duration = this.player.getDuration()
    return duration > 0 && expectedPosition(this.input!.playback, this.serverNow()) >= duration
  }

  private ended(): boolean {
    return this.player.getState() === PlayerState.Ended || this.expectedPastEnd()
  }
}
