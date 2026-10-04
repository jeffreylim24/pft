// Keeps this browser's player in step with the room (spec section 7). It
// follows only the server's broadcast state, never a person's command, so
// both browsers act on the same thing. It also corrects drift.
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { PlayerState, type Player, type PlayerStateValue } from './player'
import { usePlayerStore } from './store'
import { clampToDuration, DRIFT_LIMIT_S, driftTarget, expectedPosition } from './timing'

/** How often the player is sampled. */
export const TICK_MS = 250
export const DRIFT_CHECK_MS = 2_000
/** No drift seeks this soon after our own load or seek. */
export const SEEK_GRACE_MS = 3_000
/** How far a paused player may sit from the room position. */
export const PAUSED_TOLERANCE_S = 0.25

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

export class PlaybackSync {
  private readonly player: Player
  private readonly serverNow: () => number
  private readonly cleanups: Array<() => void> = []
  private input: SyncInput | null = null
  private loadedVideoId: string | null = null
  private lastSeekAt = -Infinity // local ms of our last load or seek

  constructor({ player, serverNow }: PlaybackSyncDeps) {
    this.player = player
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
    if (!prev?.connected || prev.playback !== next.playback || prev.you !== next.you) this.apply()
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  // Makes the player match a new room state.
  private apply(): void {
    const { playback } = this.input!
    if (playback.videoId === null) return
    const justLoaded = playback.videoId !== this.loadedVideoId
    if (justLoaded) {
      this.loadedVideoId = playback.videoId
      usePlayerStore.setState({ duration: 0, error: null, autoplayBlocked: false })
      this.cue(playback.videoId, expectedPosition(playback, this.serverNow()))
    }
    const target = this.target()
    if (playback.playing) {
      if (!justLoaded && Math.abs(this.player.getCurrentTime() - target) > DRIFT_LIMIT_S) this.seek(target)
      // play() after the end would start the video over (spec 13).
      if (!this.expectedPastEnd()) this.player.play()
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
    const input = this.input
    if (!input || input.playback.videoId === null) return
    const wantsPlaying = input.connected && input.playback.playing
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
  }

  private seek(seconds: number): void {
    this.player.seek(seconds)
    this.lastSeekAt = Date.now()
  }

  /** Where the player should be now, within the video. */
  private target(): number {
    return clampToDuration(expectedPosition(this.input!.playback, this.serverNow()), this.player.getDuration())
  }

  private expectedPastEnd(): boolean {
    const duration = this.player.getDuration()
    return duration > 0 && expectedPosition(this.input!.playback, this.serverNow()) >= duration
  }
}
