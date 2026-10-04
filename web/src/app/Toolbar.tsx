import type { RoomState } from './roomState'
import { navigate } from './routes'
import { LoadForm, PlaybackControls, VolumeSlider } from './PlaybackControls'
import { leaveRoom } from './session'
import { useAppStore } from './store'

// Playback controls work now (plan 3). Mic, camera and the pens come in plans 4 and 5.
export function Toolbar({ room }: { room: RoomState }) {
  const connected = useAppStore((s) => s.status.kind === 'open')
  return (
    <footer className="toolbar">
      <LoadForm enabled={connected} />
      <PlaybackControls playback={room.playback} enabled={connected} />
      <div className="tool-group">
        <VolumeSlider />
        <button type="button" disabled>
          Mic
        </button>
        <button type="button" disabled>
          Camera
        </button>
      </div>
      <div className="tool-group" role="group" aria-label="Pen">
        <button type="button" aria-pressed="true" disabled>
          Off
        </button>
        <button type="button" aria-pressed="false" disabled>
          Fading
        </button>
        <button type="button" aria-pressed="false" disabled>
          Sticky
        </button>
        <button type="button" disabled>
          Clear
        </button>
      </div>
      <div className="tool-group">
        <Presence room={room} />
        <button
          type="button"
          className="danger"
          onClick={() => {
            leaveRoom()
            navigate('/')
          }}
        >
          Leave
        </button>
      </div>
    </footer>
  )
}

function Presence({ room }: { room: RoomState }) {
  return (
    <ul className="presence" aria-label="People in the room">
      {room.participants.map((p) => (
        <li key={p.id} className={p.connected ? '' : 'away'}>
          <span className="dot" style={{ background: p.color }} />
          {p.name}
          {p.id === room.you && ' (you)'}
        </li>
      ))}
    </ul>
  )
}
