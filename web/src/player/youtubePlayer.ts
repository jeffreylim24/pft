// The Player interface on top of the YouTube IFrame API. The app draws its
// own controls (spec 5), so the embed shows none and has no keyboard
// shortcuts. CSS keeps the pointer off it.
import { API_LOAD_FAILED, Listeners, PlayerState, type Player, type PlayerStateValue } from './player'
import { loadYouTubeApi, type YTNamespace, type YTPlayer } from './youtubeApi'

const PLAYER_VARS = { controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0 }
/**
 * A player that isn't ready by then never will be: YouTube's second script
 * was blocked, say, or a privacy extension replaced the iframe.
 */
export const READY_TIMEOUT_MS = 15_000

export class YouTubePlayer implements Player {
  private readonly host: HTMLElement
  private embed: YTPlayer | null = null
  private ready = false
  private destroyed = false
  private queue: Array<(yt: YTPlayer) => void> = [] // commands sent before onReady
  private readyTimer: ReturnType<typeof setTimeout> | undefined
  private readonly stateListeners = new Listeners<[PlayerStateValue]>()
  private readonly errorListeners = new Listeners<[number]>()
  private readonly blockedListeners = new Listeners<[]>()

  constructor(host: HTMLElement, loadApi: () => Promise<YTNamespace> = loadYouTubeApi) {
    this.host = host
    // YouTube replaces this element with its iframe. It's ours, not React's.
    const target = document.createElement('div')
    host.append(target)
    // A player that never loads would otherwise stay silent and hold the room.
    this.readyTimer = setTimeout(() => this.failToLoad(), READY_TIMEOUT_MS)
    loadApi().then(
      (YT) => {
        if (this.destroyed) return
        try {
          this.embed = new YT.Player(target, {
            width: '100%',
            height: '100%',
            playerVars: { ...PLAYER_VARS, origin: location.origin },
            events: {
              onReady: () => this.becameReady(),
              onStateChange: (e) => this.stateListeners.emit(e.data as PlayerStateValue),
              onError: (e) => this.errorListeners.emit(e.data),
              onAutoplayBlocked: () => this.blockedListeners.emit(),
            },
          })
        } catch {
          this.failToLoad()
        }
      },
      () => this.failToLoad(),
    )
  }

  load(videoId: string, startSeconds = 0): void {
    this.run((yt) => yt.cueVideoById({ videoId, startSeconds }))
  }

  play(): void {
    this.run((yt) => yt.playVideo())
  }

  pause(): void {
    this.run((yt) => yt.pauseVideo())
  }

  seek(seconds: number): void {
    this.run((yt) => yt.seekTo(seconds, true))
  }

  setVolume(volume: number): void {
    this.run((yt) => yt.setVolume(volume))
  }

  getCurrentTime(): number {
    return (this.ready && this.embed?.getCurrentTime()) || 0
  }

  getDuration(): number {
    return (this.ready && this.embed?.getDuration()) || 0
  }

  getState(): PlayerStateValue {
    if (!this.ready || !this.embed) return PlayerState.Unstarted
    return this.embed.getPlayerState() as PlayerStateValue
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
    this.ready = false
    this.queue = []
    clearTimeout(this.readyTimer)
    try {
      this.embed?.destroy() // may throw before onReady, when YouTube hasn't added its methods yet
    } catch {
      /* the iframe is removed below anyway */
    } finally {
      this.embed = null
      this.host.replaceChildren()
    }
  }

  private becameReady(): void {
    if (this.destroyed || !this.embed) return
    clearTimeout(this.readyTimer)
    this.ready = true
    for (const command of this.queue.splice(0)) command(this.embed)
  }

  // Reported once, as the "didn't load" error.
  private failToLoad(): void {
    clearTimeout(this.readyTimer)
    if (!this.destroyed) this.errorListeners.emit(API_LOAD_FAILED)
  }

  private run(command: (yt: YTPlayer) => void): void {
    if (this.ready && this.embed) command(this.embed)
    else this.queue.push(command)
  }
}
