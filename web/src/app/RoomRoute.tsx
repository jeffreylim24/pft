import { ErrorPage } from './ErrorPage'
import { Lobby } from './Lobby'
import { RoomPage } from './RoomPage'
import { useAppStore } from './store'

const IDLE = { kind: 'idle' } as const

/** Picks the lobby, the room or an error page for /r/<roomId>. */
export function RoomRoute({ roomId }: { roomId: string }) {
  const status = useAppStore((s) => (s.roomId === roomId ? s.status : IDLE))
  const hasRoom = useAppStore((s) => s.roomId === roomId && s.room !== null)
  switch (status.kind) {
    case 'idle':
      return <Lobby roomId={roomId} joining={false} />
    case 'connecting':
    case 'reconnecting':
    case 'open':
      // Until the first welcome, stay in the lobby with the button busy.
      return hasRoom ? <RoomPage /> : <Lobby roomId={roomId} joining />
    case 'closed':
      return status.reason === 'left' ? <Lobby roomId={roomId} joining={false} /> : <ErrorPage kind={status.reason} />
  }
}
