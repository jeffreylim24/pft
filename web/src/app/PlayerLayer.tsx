// Stage layer 1: the YouTube player, kept in step with the room by
// PlaybackSync. When the browser blocks playback it offers a button, and
// lets clicks reach the video, so one click can start it.
import { useEffect, useRef } from 'react'
import type { Player } from '../player/player'
import { usePlayerStore } from '../player/store'
import { PlaybackSync } from '../player/sync'
import { YouTubePlayer } from '../player/youtubePlayer'
import { getRoomClient } from './session'
import { useAppStore, type AppState } from './store'

export type CreatePlayer = (host: HTMLElement) => Player

const createYouTubePlayer: CreatePlayer = (host) => new YouTubePlayer(host)

export function PlayerLayer({ createPlayer = createYouTubePlayer }: { createPlayer?: CreatePlayer }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<Player | null>(null)
  const hasVideo = useAppStore((s) => s.room?.playback.videoId != null)
  const blocked = usePlayerStore((s) => s.autoplayBlocked)

  useEffect(() => {
    const player = createPlayer(hostRef.current!)
    playerRef.current = player
    const sync = new PlaybackSync({
      player,
      send: (msg) => getRoomClient()?.send(msg) ?? false,
      serverNow: () => getRoomClient()?.serverNow() ?? Date.now(),
    })
    const feed = ({ room, status }: AppState) => {
      if (room) sync.update({ playback: room.playback, you: room.you, connected: status.kind === 'open' })
    }
    feed(useAppStore.getState())
    const unsubscribe = useAppStore.subscribe(feed)
    return () => {
      unsubscribe()
      sync.destroy()
      player.destroy()
      playerRef.current = null
    }
  }, [createPlayer])

  const classes = ['player-layer', hasVideo ? '' : 'empty', blocked ? 'clickable' : ''].filter(Boolean).join(' ')
  return (
    <>
      <div ref={hostRef} className={classes} />
      {blocked && (
        <div className="autoplay-prompt" role="alert">
          <p>Your browser blocked the video from playing.</p>
          {/* play() runs inside the click, so the browser sees a user gesture. */}
          <button type="button" className="primary" onClick={() => playerRef.current?.play()}>
            Start video
          </button>
        </div>
      )}
    </>
  )
}
