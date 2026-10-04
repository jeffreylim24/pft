// The video player, behind an interface so the sync logic can be tested
// with FakePlayer instead of a real YouTube embed (spec 4.3).

/** YouTube's player states, which FakePlayer uses too. */
export const PlayerState = {
  Unstarted: -1,
  Ended: 0,
  Playing: 1,
  Paused: 2,
  Buffering: 3,
  Cued: 5,
} as const
export type PlayerStateValue = (typeof PlayerState)[keyof typeof PlayerState]

export interface Player {
  /** Shows a video at startSeconds without playing it. */
  load(videoId: string, startSeconds?: number): void
  play(): void
  pause(): void
  seek(seconds: number): void
  /** 0 to 100, this browser only. */
  setVolume(volume: number): void
  getCurrentTime(): number
  /** 0 until the video's metadata has loaded. */
  getDuration(): number
  getState(): PlayerStateValue
  /** Each on* method returns a function that removes the listener. */
  onStateChange(listener: (state: PlayerStateValue) => void): () => void
  onError(listener: (code: number) => void): () => void
  /** The browser refused to start playback without a click. */
  onAutoplayBlocked(listener: () => void): () => void
  destroy(): void
}

/** A set of callbacks, for the on* methods above. */
export class Listeners<T extends unknown[]> {
  private readonly set = new Set<(...args: T) => void>()

  add(listener: (...args: T) => void): () => void {
    this.set.add(listener)
    return () => this.set.delete(listener)
  }

  emit(...args: T): void {
    for (const listener of [...this.set]) listener(...args)
  }
}

/** YouTube errors meaning the video can't be shown in an embed (spec 7.4). */
export const UNPLAYABLE_ERRORS: readonly number[] = [2, 5, 100, 101, 150]
/** Our own code: the IFrame API script didn't load. */
export const API_LOAD_FAILED = -1

export function playerErrorMessage(code: number): string {
  if (UNPLAYABLE_ERRORS.includes(code)) return "This video can't be played here."
  if (code === API_LOAD_FAILED) return "The YouTube player didn't load. Check your connection, then reload the page."
  return `The video player stopped with error ${code}.`
}
