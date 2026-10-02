import { useEffect } from 'react'
import { ErrorPage } from './ErrorPage'
import { Landing } from './Landing'
import { RoomRoute } from './RoomRoute'
import { useRoute } from './routes'
import { syncSessionWithRoute } from './session'

export function App() {
  const route = useRoute()
  useEffect(() => syncSessionWithRoute(route), [route])
  switch (route.page) {
    case 'landing':
      return <Landing />
    case 'room':
      return <RoomRoute roomId={route.roomId} />
    case 'unknown':
      return <ErrorPage kind="not_found" />
  }
}
