// Facts about this browser's player that never go over the wire. Room state
// stays in app/store.ts. PlaybackSync writes these, and setMovieVolume
// writes the volume for the toolbar slider.
import { create } from 'zustand'

export interface PlayerFacts {
  /** Seconds. 0 until the player knows. */
  duration: number
  /** The player's last error code, until the next video loads. */
  error: number | null
  /** The browser refused to start playback without a click. */
  autoplayBlocked: boolean
  /** 0 to 100. Local only, and not saved. */
  volume: number
}

export const initialPlayerFacts: PlayerFacts = { duration: 0, error: null, autoplayBlocked: false, volume: 100 }

export const usePlayerStore = create<PlayerFacts>()(() => initialPlayerFacts)

export function setMovieVolume(volume: number): void {
  usePlayerStore.setState({ volume: Math.min(Math.max(volume, 0), 100) })
}
