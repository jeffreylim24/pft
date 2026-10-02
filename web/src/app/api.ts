import { ROOM_ID } from './routes'

/** POST /api/rooms. Resolves to the new room's ID; rejects with a message for people. */
export async function createRoom(fetchFn: typeof fetch = fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchFn('/api/rooms', { method: 'POST' })
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.")
  }
  if (res.status === 503) throw new Error('Too many rooms are open right now. Try again in a few minutes.')
  if (res.status !== 201) throw new Error(`Couldn't create a room (HTTP ${res.status}). Try again.`)
  const body: unknown = await res.json().catch(() => null)
  const roomId = (body as { roomId?: unknown } | null)?.roomId
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) {
    throw new Error("The server's reply didn't include a room. Try again.")
  }
  return roomId
}
