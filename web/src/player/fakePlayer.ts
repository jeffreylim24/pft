// A Player with no YouTube behind it. Its time follows a clock (Date.now
// unless told otherwise, so Vitest's fake timers move it), and it copies the
// YouTube quirks the sync logic has to cope with. Unit tests drive it
// directly. Plan 6's end-to-end tests will run the app with it.
import { Listeners, PlayerState, type Player, type PlayerStateValue } from './player'

export interface FakePlayerOptions {
  /** The duration every video reports once it starts playing. Default 600. */
  videoDuration?: number
  now?: () => number
}

export class FakePlayer implements Player {
  /** Every command in order: 'load:<id>@<start>', 'play', 'pause', 'seek:<s>'. */
  readonly calls: string[] = []
  videoId: string | null = null
  volume = 100
  destroyed = false
  private state: PlayerStateValue = PlayerState.Unstarted
  private base = 0 // the player's time when `since` was taken
  private since = 0 // clock ms
  private duration = 0
  private frozen = false
  private autoplayAllowed = true
  private readonly videoDuration: number
  private readonly now: () => number
  private readonly stateListeners = new Listeners<[PlayerStateValue]>()
  private readonly errorListeners = new Listeners<[number]>()
  private readonly blockedListeners = new Listeners<[]>()

  constructor(opts: FakePlayerOptions = {}) {
    this.videoDuration = opts.videoDuration ?? 600
    this.now = opts.now ?? (() => Date.now())
  }

  load(videoId: string, startSeconds = 0): void {
    this.calls.push(`load:${videoId}@${round(startSeconds)}`)
    this.videoId = videoId
    this.duration = 0
    this.frozen = false
    this.setTime(startSeconds)
    this.setState(PlayerState.Cued)
  }

  play(): void {
    this.calls.push('play')
    // Like YouTube: playing a video that has ended starts it over.
    this.start(this.state === PlayerState.Ended ? 0 : this.getCurrentTime())
  }

  pause(): void {
    this.calls.push('pause')
    if (this.state !== PlayerState.Playing) return
    this.setTime(this.getCurrentTime())
    this.setState(PlayerState.Paused)
  }

  seek(seconds: number): void {
    this.calls.push(`seek:${round(seconds)}`)
    const to = this.duration > 0 ? Math.min(seconds, this.duration) : seconds
    this.setTime(to)
    // Like YouTube: a seek from any state but paused or playing starts playback.
    if (this.state !== PlayerState.Paused && this.state !== PlayerState.Playing) this.start(to)
  }

  setVolume(volume: number): void {
    this.volume = volume
  }

  getCurrentTime(): number {
    const running = this.state === PlayerState.Playing && !this.frozen
    const t = running ? this.base + (this.now() - this.since) / 1000 : this.base
    return this.duration > 0 ? Math.min(t, this.duration) : t
  }

  getDuration(): number {
    return this.duration
  }

  getState(): PlayerStateValue {
    if (this.state === PlayerState.Playing && this.duration > 0 && this.getCurrentTime() >= this.duration) {
      this.setTime(this.duration)
      this.setState(PlayerState.Ended)
    }
    return this.state
  }

  onStateChange(listener: (state: PlayerStateValue) => void): () => void {
    return this.stateListeners.add(listener)
  }

  onError(listener: (code: number) => void): () => void {
    return this.errorListeners.add(listener)
  }

  onAutoplayBlocked(listener: () => void): () => void {
    return this.blockedListeners.add(listener)
  }

  destroy(): void {
    this.destroyed = true
  }

  // ---- driven by tests ----

  /** Time stops while the player still says it's playing, as during an ad. */
  stall(): void {
    this.setTime(this.getCurrentTime())
    this.frozen = true
  }

  unstall(): void {
    this.frozen = false
    this.since = this.now()
  }

  /** Moves the time without a command, as if the player ran fast or slow. */
  skew(seconds: number): void {
    this.setTime(this.getCurrentTime() + seconds)
  }

  blockAutoplay(blocked = true): void {
    this.autoplayAllowed = !blocked
  }

  fail(code: number): void {
    this.errorListeners.emit(code)
  }

  private start(from: number): void {
    if (!this.autoplayAllowed) {
      this.blockedListeners.emit()
      return
    }
    if (this.duration === 0) this.duration = this.videoDuration
    this.setTime(from)
    this.setState(PlayerState.Playing) // last, because a listener may pause at once
  }

  private setTime(seconds: number): void {
    this.base = seconds
    this.since = this.now()
  }

  private setState(state: PlayerStateValue): void {
    if (state === this.state) return
    this.state = state
    this.stateListeners.emit(state)
  }
}

const round = (n: number) => Math.round(n * 100) / 100
