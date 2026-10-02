import type { ReactNode } from 'react'
import { CreateRoomButton } from './Landing'
import { resetSession } from './session'

export type ErrorKind = 'room_full' | 'not_found' | 'replaced' | 'rejected'

const pages: Record<ErrorKind, { title: string; body: string; action: () => ReactNode }> = {
  room_full: {
    title: 'This room is full',
    body: 'A room holds two people, and both seats are taken. Start a room of your own instead.',
    action: () => <CreateRoomButton />,
  },
  not_found: {
    title: 'Room not found',
    body: 'The link may be mistyped, or the room closed after 30 minutes with nobody in it.',
    action: () => <CreateRoomButton />,
  },
  replaced: {
    title: "You're in this room in another tab",
    body: 'The room is open in another tab or window, so this one stepped aside.',
    action: () => (
      <button type="button" className="primary" onClick={resetSession}>
        Use this tab instead
      </button>
    ),
  },
  rejected: {
    title: "Couldn't join the room",
    body: "The server didn't accept this tab's request to join. Going back to the lobby usually fixes it.",
    action: () => (
      <button type="button" className="primary" onClick={resetSession}>
        Back to the lobby
      </button>
    ),
  },
}

export function ErrorPage({ kind }: { kind: ErrorKind }) {
  const page = pages[kind]
  return (
    <main className="center-page">
      <div className="card message-card">
        <h1>{page.title}</h1>
        <p>{page.body}</p>
        {page.action()}
      </div>
    </main>
  )
}
