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
  storage?: StorageLike // where resume tokens live; sessionStorage by default
  createSocket?: (url: string) => SocketLike
}

let active: { client: RoomClient; roomId: string; storage: StorageLike } | null = null

const tokenKey = (roomId: string) => `popcorn.resume.${roomId}`

/** The token from an earlier welcome in this tab (it survives a reload). */
export function savedResumeToken(roomId: string, storage = browserStorage('sessionStorage')): string | null {
  return storage.getItem(tokenKey(roomId))
}

export function getRoomClient(): RoomClient | null {
  return active?.client ?? null
}

export function joinRoom(roomId: string, profile: Profile, deps: SessionDeps = {}): void {
  active?.client.leave()
  const storage = deps.storage ?? browserStorage('sessionStorage')
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

/** Leaving the room's page (Back, or a typed URL) leaves the room and turns the camera off. */
export function syncSessionWithRoute(route: Route): void {
  const routeRoom = route.page === 'room' ? route.roomId : null
  const { roomId } = useAppStore.getState()
  if (roomId !== null && roomId !== routeRoom) leaveRoom()
  if (routeRoom === null) releaseLocalMedia()
}
