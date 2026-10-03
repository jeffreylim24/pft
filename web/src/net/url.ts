/** The WebSocket URL for a room, on the same host as the page. */
export function roomSocketUrl(page: { protocol: string; host: string }, roomId: string): string {
  const scheme = page.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${page.host}/ws?room=${encodeURIComponent(roomId)}`
}
