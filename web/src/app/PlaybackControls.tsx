// The toolbar's playback controls (spec 5). They only send commands. What
// the room does comes back as a playback broadcast, for the sender too
// (spec 7.2).
import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react'
import { setMovieVolume, usePlayerStore } from '../player/store'
import { clampToDuration, expectedPosition, formatTime } from '../player/timing'
import { parseVideoId } from '../player/youtubeUrl'
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { getRoomClient } from './session'

const TIME_REFRESH_MS = 250

function send(msg: ClientMessage): boolean {
  return getRoomClient()?.send(msg) ?? false
}

function serverNow(): number {
  return getRoomClient()?.serverNow() ?? Date.now()
}

export function LoadForm({ enabled }: { enabled: boolean }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const videoId = parseVideoId(text)
    if (videoId === null) {
      setError("That isn't a YouTube link.")
      return
    }
    if (send({ type: 'playback.load', videoId })) setText('')
  }

  return (
    <form className="tool-group grow" onSubmit={submit}>
      <input
        className="url-input"
        placeholder="Paste a YouTube link"
        aria-label="YouTube link"
        aria-invalid={error !== null}
        value={text}
        disabled={!enabled}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
      />
      <button type="submit" disabled={!enabled || text.trim() === ''}>
        Load
      </button>
      {error && (
        <span className="load-error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}

/** Re-renders every 250 ms while active, so a playing room's time moves. */
function useTicker(active: boolean): void {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(tick, TIME_REFRESH_MS)
    return () => clearInterval(id)
  }, [active])
}

export function PlaybackControls({ playback, enabled }: { playback: PlaybackState; enabled: boolean }) {
  const duration = usePlayerStore((s) => s.duration)
  const [scrub, setScrub] = useState<number | null>(null) // the seek bar's value while it's being dragged
  const scrubRef = useRef<number | null>(null) // the same, for the native change listener
  const seekRef = useRef<HTMLInputElement>(null)
  useTicker(playback.playing)
  const hasVideo = playback.videoId !== null
  const expected = expectedPosition(playback, serverNow())
  const atEnd = duration > 0 && expected >= duration
  const playing = playback.playing && !atEnd
  const position = clampToDuration(expected, duration)

  function togglePlay() {
    const now = expectedPosition(playback, serverNow())
    const at = clampToDuration(now, duration)
    if (playing) send({ type: 'playback.pause', position: at })
    else send({ type: 'playback.play', position: duration > 0 && now >= duration ? 0 : at })
  }

  function scrubTo(value: number | null) {
    scrubRef.current = value
    setScrub(value)
  }

  // The native change event fires once when a drag ends (mouse, touch or a
  // cancelled pointer) and once per key step. React's onChange follows the
  // input event instead, so it only moves the bar.
  useEffect(() => {
    const input = seekRef.current!
    const commit = () => {
      const position = scrubRef.current
      if (position === null) return
      scrubTo(null)
      send({ type: 'playback.seek', position })
    }
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  }, [])

  // A drop mid-drag forgets the scrub, so it can't be sent later.
  useEffect(() => {
    if (!enabled) scrubTo(null)
  }, [enabled])

  return (
    <div className="tool-group">
      <button type="button" aria-label={playing ? 'Pause' : 'Play'} disabled={!enabled || !hasVideo} onClick={togglePlay}>
        {playing ? '⏸' : '▶'}
      </button>
      <input
        ref={seekRef}
        type="range"
        className="seek"
        aria-label="Seek"
        min={0}
        max={duration}
        step={0.1}
        value={scrub ?? position}
        disabled={!enabled || !hasVideo || duration === 0}
        onChange={(e) => scrubTo(Number(e.target.value))}
      />
      <span className="time">{`${formatTime(scrub ?? position)} / ${formatTime(duration)}`}</span>
    </div>
  )
}

export function VolumeSlider() {
  const volume = usePlayerStore((s) => s.volume)
  return (
    <input
      type="range"
      className="volume"
      aria-label="Volume"
      min={0}
      max={100}
      value={volume}
      onChange={(e) => setMovieVolume(Number(e.target.value))}
    />
  )
}
