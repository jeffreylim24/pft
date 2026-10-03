const FIRST_DELAY_MS = 500
const MAX_DELAY_MS = 8000

/** How long to wait before reconnect attempt n (0-based): 0.5s, 1s, 2s, 4s, then 8s. */
export function backoffDelay(n: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** n, MAX_DELAY_MS)
}
