// Two real pages, so a few lines of history handling instead of a router.
import { useMemo, useSyncExternalStore } from 'react'

export type Route = { page: 'landing' } | { page: 'room'; roomId: string } | { page: 'unknown' }

/** Room IDs are 128 random bits, base64url-encoded: 22 characters. */
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { page: 'landing' }
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname)
  if (m && ROOM_ID.test(m[1])) return { page: 'room', roomId: m[1] }
  return { page: 'unknown' }
}

export function roomPath(roomId: string): string {
  return `/r/${roomId}`
}

const NAVIGATE = 'popcorn:navigate'

export function navigate(path: string): void {
  if (path === location.pathname) return
  history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATE))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE, onChange)
  }
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname)
  return useMemo(() => parseRoute(pathname), [pathname])
}
