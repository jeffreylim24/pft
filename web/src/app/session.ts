// Wires the RoomClient to the store. Pages call joinRoom and leaveRoom;
// later plans reach the client through getRoomClient to send messages.
import { RoomClient, type SocketLike } from '../net/client'
import { randomId } from '../net/ids'
import { roomSocketUrl } from '../net/url'
import { releaseLocalMedia } from './media'
import type { Profile } from './prefs'
import { applyServerMessage } from './roomState'
import type { Route } from './routes'
import { browserStorage, type StorageLike } from './storage'
import { initialAppState, useAppStore } from './store'

/** One per page load, so the partner can tell a reload from a dropped socket. */
const pageSession = randomId()

export interface SessionDeps {
  page?: { protocol: string; host: string }
  storage?: StorageLike // where resume tokens live; localStorage by default
  createSocket?: (url: string) => SocketLike
}

let active: { client: RoomClient; roomId: string; storage: StorageLike } | null = null

// Tokens are kept in localStorage, so every tab in this browser is the same
// person: a reload, a duplicated tab (Safari doesn't copy sessionStorage),
// or the link reopened while the seat is held. A hello with the token takes
// over the seat, and the server closes the old tab with 4001.
const tokenKey = (roomId: string) => `popcorn.resume.${roomId}`

/** The token from an earlier welcome in any tab of this browser. */
export function savedResumeToken(roomId: string, storage = browserStorage('localStorage')): string | null {
  return storage.getItem(tokenKey(roomId))
}

export function getRoomClient(): RoomClient | null {
  return active?.client ?? null
}

export function joinRoom(roomId: string, profile: Profile, deps: SessionDeps = {}): void {
  active?.client.leave()
  const storage = deps.storage ?? browserStorage('localStorage')
  const client = new RoomClient({
    url: roomSocketUrl(deps.page ?? location, roomId),
    hello: { name: profile.name.trim(), color: profile.color, pageSession },
    resumeToken: storage.getItem(tokenKey(roomId)),
    onResumeToken: (token) => storage.setItem(tokenKey(roomId), token),
    createSocket: deps.createSocket,
  })
  active = { client, roomId, storage }
  useAppStore.setState({ roomId, status: client.status, room: null })
  client.onStatus((status) => {
    // An expired room's token would otherwise say "Welcome back" forever.
    if (status.kind === 'closed' && status.reason === 'not_found') storage.removeItem(tokenKey(roomId))
    if (active?.client === client) useAppStore.setState({ status })
  })
  client.subscribe((msg) => {
    if (active?.client === client) useAppStore.setState((s) => ({ room: applyServerMessage(s.room, msg) }))
  })
  client.connect()
}

/** The Leave button: frees the seat now and forgets the resume token. */
export function leaveRoom(): void {
  if (active) {
    active.client.leave()
    active.storage.removeItem(tokenKey(active.roomId))
  }
  resetSession()
}

/** Back to the lobby without leaving, e.g. to rejoin after another tab took over. */
export function resetSession(): void {
  active = null
  useAppStore.setState(initialAppState)
}

/**
 * Moving off the room's route inside the app (Back to the landing page, or
 * Leave) leaves the room and turns the camera off. Leaving the document
 * itself (closing the tab, a typed URL) can't be told apart from a reload,
 * so the server holds the seat for its grace period instead.
 */
export function syncSessionWithRoute(route: Route): void {
  const routeRoom = route.page === 'room' ? route.roomId : null
  const { roomId } = useAppStore.getState()
  if (roomId !== null && roomId !== routeRoom) leaveRoom()
  if (routeRoom === null) releaseLocalMedia()
}
