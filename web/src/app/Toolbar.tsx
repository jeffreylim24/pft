import type { RoomState } from './roomState'
import { navigate } from './routes'
import { leaveRoom } from './session'

// The controls are laid out now; plans 3-5 bring them to life.
export function Toolbar({ room }: { room: RoomState }) {
  return (
    <footer className="toolbar">
      <div className="tool-group grow">
        <input className="url-input" placeholder="Paste a YouTube link" aria-label="YouTube link" disabled />
        <button type="button" disabled>
          Load
        </button>
      </div>
      <div className="tool-group">
        <button type="button" aria-label="Play" disabled>
          ▶
        </button>
        <input type="range" className="seek" aria-label="Seek" disabled />
        <span className="time">0:00 / 0:00</span>
      </div>
      <div className="tool-group">
        <input type="range" className="volume" aria-label="Volume" disabled />
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
