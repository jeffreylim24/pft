// Clock offset between this browser and the server (spec section 7.3).
// Server time is then Date.now() + offset.

export interface ClockSample {
  rtt: number
  offset: number
}

/** One ping/pong exchange: sent at t0, answered at t1, both local ms. */
export function sampleFromPong(t0: number, t1: number, serverTime: number): ClockSample {
  const rtt = t1 - t0
  return { rtt, offset: serverTime - (t0 + rtt / 2) }
}

/**
 * The offset from the sample with the shortest round trip: it had the least
 * room for network delay to be lopsided. Null if there are no samples.
 */
export function bestOffset(samples: readonly ClockSample[]): number | null {
  let best: ClockSample | null = null
  for (const s of samples) {
    if (best === null || s.rtt < best.rtt) best = s
  }
  return best === null ? null : best.offset
}
