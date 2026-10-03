/**
 * A random URL-safe ID (16 characters by default). Uses getRandomValues, not
 * randomUUID, because randomUUID is missing on plain-http LAN addresses.
 */
export function randomId(bytes = 12): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
