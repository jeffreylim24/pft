import { useState } from 'react'
import { createRoom } from './api'
import { navigate, roomPath } from './routes'

export function Landing() {
  return (
    <main className="center-page">
      <div className="hero">
        <div className="hero-logo" aria-hidden="true">
          🍿
        </div>
        <h1>Popcorn for Two</h1>
        <p className="lede">Watch YouTube together, face to face, from anywhere.</p>
        <CreateRoomButton />
      </div>
    </main>
  )
}

export function CreateRoomButton() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    setError(null)
    try {
      navigate(roomPath(await createRoom()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="create-room">
      <button type="button" className="primary big" onClick={create} disabled={busy}>
        {busy ? 'Creating…' : 'Create room'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
