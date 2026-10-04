// Playback arithmetic shared by the sync logic and the toolbar (spec 7.1,
// 7.3). Positions are in seconds and clocks are in Unix ms.
import type { PlaybackState } from '../protocol/schemas'

/** Drift beyond this many seconds is corrected with a seek. */
export const DRIFT_LIMIT_S = 1.0

/** Where playback should be at server time serverNowMs. */
export function expectedPosition(
  pb: Pick<PlaybackState, 'playing' | 'position' | 'updatedAt'>,
  serverNowMs: number,
): number {
  if (!pb.playing) return pb.position
  return pb.position + Math.max(serverNowMs - pb.updatedAt, 0) / 1000
}

/** A duration of 0 means it isn't known yet. */
export function clampToDuration(position: number, duration: number): number {
  return duration > 0 ? Math.min(position, duration) : position
}

/**
 * Where to seek a playing player, or null if it's close enough. Clamping
 * to the duration means a video that has ended is left alone (spec 13).
 */
export function driftTarget(current: number, expected: number, duration: number): number | null {
  const target = clampToDuration(expected, duration)
  return Math.abs(current - target) > DRIFT_LIMIT_S ? target : null
}

/** 61 → "1:01", 3725 → "1:02:05". */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
