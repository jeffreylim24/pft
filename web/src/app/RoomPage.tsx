import { useState } from 'react'
import { Stage } from '../stage/Stage'
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
        <div className="stage-empty">
          <span aria-hidden="true">🍿</span>
          <p>No video loaded</p>
        </div>
        <PartnerNotice room={room} />
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
