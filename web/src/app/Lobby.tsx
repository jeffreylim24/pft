import { useState, type FormEvent } from 'react'
import { MAX_NAME_CHARS } from '../protocol/schemas'
import { useLocalMedia, type LocalMedia } from './media'
import { InitialTile, MicMeter, VideoView } from './MediaViews'
import { isValidName, loadProfile, PALETTE, saveProfile, type Profile } from './prefs'
import { joinRoom, savedResumeToken } from './session'
import { browserStorage } from './storage'

export function Lobby({ roomId, joining }: { roomId: string; joining: boolean }) {
  const [profile, setProfile] = useState(() => loadProfile(browserStorage('localStorage')))
  const [media, retryMedia] = useLocalMedia()
  // A token means this tab was in the room before a reload.
  const [rejoining] = useState(() => savedResumeToken(roomId) !== null)
  const canJoin = isValidName(profile.name) && !joining

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!canJoin) return
    const chosen = { name: profile.name.trim(), color: profile.color }
    saveProfile(browserStorage('localStorage'), chosen)
    joinRoom(roomId, chosen)
  }

  return (
    <main className="center-page">
      <form className="card lobby" onSubmit={submit}>
        <Preview media={media} profile={profile} onRetry={retryMedia} />
        <div className="lobby-form">
          <h1>{rejoining ? 'Welcome back' : 'Join the watch party'}</h1>
          <label className="field">
            <span>Your name</span>
            <input
              value={profile.name}
              maxLength={MAX_NAME_CHARS}
              autoComplete="nickname"
              autoFocus
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </label>
          <fieldset className="field swatches">
            <legend>Your color</legend>
            {PALETTE.map((color) => (
              <label key={color} className="swatch" style={{ background: color }}>
                <input
                  type="radio"
                  name="color"
                  value={color}
                  aria-label={`Color ${color}`}
                  checked={profile.color === color}
                  onChange={() => setProfile({ ...profile, color })}
                />
              </label>
            ))}
          </fieldset>
          <p className="tip">🎧 Headphones recommended: without them, the movie can echo back through your mic.</p>
          <button type="submit" className="primary big" disabled={!canJoin}>
            {joining ? 'Joining…' : rejoining ? 'Rejoin' : 'Join'}
          </button>
        </div>
      </form>
    </main>
  )
}

function Preview({ media, profile, onRetry }: { media: LocalMedia; profile: Profile; onRetry: () => void }) {
  const showVideo = media.status === 'ready' && media.hasVideo
  return (
    <div className="preview">
      <div className="preview-frame">
        {showVideo ? <VideoView stream={media.stream} mirrored /> : <InitialTile name={profile.name} color={profile.color} />}
      </div>
      <div className="preview-status">
        {media.status === 'pending' && <span>Asking for your camera and mic…</span>}
        {media.status === 'ready' && (media.hasAudio ? <MicMeter stream={media.stream} /> : <span>No mic found.</span>)}
        {media.status === 'ready' && !media.hasVideo && <span>No camera found. You can still join.</span>}
        {(media.status === 'blocked' || media.status === 'unavailable') && (
          <>
            <span>
              {media.status === 'blocked'
                ? "Camera and mic are blocked. Allow them in your browser's site settings, then retry. You can still join."
                : 'No camera or mic found. You can still join.'}
            </span>
            <button type="button" className="link" onClick={onRetry}>
              Retry camera
            </button>
          </>
        )}
      </div>
    </div>
  )
}
