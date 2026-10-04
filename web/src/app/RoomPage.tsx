import { useState } from 'react'
import { playerErrorMessage } from '../player/player'
import { usePlayerStore } from '../player/store'
import { Stage } from '../stage/Stage'
import { PlayerLayer } from './PlayerLayer'
import type { RoomState } from './roomState'
import { useAppStore } from './store'
import { Toolbar } from './Toolbar'

export function RoomPage() {
  const status = useAppStore((s) => s.status)
  const room = useAppStore((s) => s.room)
  if (!room) return null
  return (
    <div className="room">
      <Stage>
        <PlayerLayer />
        {room.playback.videoId === null && (
          <div className="stage-empty">
            <span aria-hidden="true">🍿</span>
            <p>No video loaded</p>
          </div>
        )}
        <div className="notices">
          <PartnerNotice room={room} />
          <PlaybackNotice room={room} />
        </div>
      </Stage>
      {status.kind === 'reconnecting' && (
        <div className="banner" role="status">
          Reconnecting…
        </div>
      )}
      <Toolbar room={room} />
    </div>
  )
}

function PartnerNotice({ room }: { room: RoomState }) {
  const partner = room.participants.find((p) => p.id !== room.you)
  if (!partner) {
    return (
      <div className="notice" role="status">
        <p>Waiting for your partner. Send them this room's link.</p>
        <CopyLinkButton />
      </div>
    )
  }
  if (!partner.connected) {
    return (
      <div className="notice" role="status">
        <p>{partner.name} is reconnecting…</p>
      </div>
    )
  }
  return null
}

function PlaybackNotice({ room }: { room: RoomState }) {
  const error = usePlayerStore((s) => s.error)
  const { waitingFor } = room.playback
  if (error !== null) {
    return (
      <div className="notice" role="alert">
        <p>{playerErrorMessage(error)}</p>
      </div>
    )
  }
  if (waitingFor === null) return null
  if (waitingFor === room.you) {
    return (
      <div className="notice" role="status">
        <p>Waiting for your video to catch up…</p>
      </div>
    )
  }
  const partner = room.participants.find((p) => p.id === waitingFor)
  if (!partner?.connected) return null // PartnerNotice already says they're reconnecting
  return (
    <div className="notice" role="status">
      <p>Waiting for {partner.name}…</p>
    </div>
  )
}

function CopyLinkButton() {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link:', location.href) // no clipboard access (e.g. plain http)
    }
  }
  return (
    <button type="button" className="primary" onClick={copy}>
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  )
}
