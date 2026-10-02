// The camera and mic, opened in the lobby and kept for the call (plan 4).
import { useCallback, useEffect, useState } from 'react'

export type LocalMedia =
  | { status: 'pending' }
  | { status: 'ready'; stream: MediaStream; hasVideo: boolean; hasAudio: boolean }
  | { status: 'blocked' } // the person or the browser said no
  | { status: 'unavailable' } // no devices, or no getUserMedia (plain-http LAN address)

type Devices = Pick<MediaDevices, 'getUserMedia'> | undefined

const audio = { echoCancellation: true, noiseSuppression: true }

let current: Promise<LocalMedia> | null = null

/** Opens the camera and mic once; later calls share the same result. */
export function acquireLocalMedia(devices: Devices = globalThis.navigator?.mediaDevices): Promise<LocalMedia> {
  current ??= request(devices)
  return current
}

/** Turns the camera and mic off. The next acquire asks again. */
export function releaseLocalMedia(): void {
  const old = current
  current = null
  void old?.then((m) => {
    if (m.status === 'ready') for (const track of m.stream.getTracks()) track.stop()
  })
}

async function request(devices: Devices): Promise<LocalMedia> {
  if (!devices?.getUserMedia) return { status: 'unavailable' }
  try {
    return ready(await devices.getUserMedia({ video: true, audio }))
  } catch (err) {
    if (isDenied(err)) return { status: 'blocked' }
  }
  // No camera, or another app has it: the mic alone still makes a call.
  try {
    return ready(await devices.getUserMedia({ audio }))
  } catch (err) {
    return isDenied(err) ? { status: 'blocked' } : { status: 'unavailable' }
  }
}

function ready(stream: MediaStream): LocalMedia {
  return {
    status: 'ready',
    stream,
    hasVideo: stream.getVideoTracks().length > 0,
    hasAudio: stream.getAudioTracks().length > 0,
  }
}

function isDenied(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'NotAllowedError' || name === 'SecurityError'
}

/** The local media for a component, plus a retry that asks again. */
export function useLocalMedia(): [LocalMedia, () => void] {
  const [media, setMedia] = useState<LocalMedia>({ status: 'pending' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    void acquireLocalMedia().then((m) => {
      if (live) setMedia(m)
    })
    return () => {
      live = false
    }
  }, [attempt])
  const retry = useCallback(() => {
    releaseLocalMedia()
    setMedia({ status: 'pending' })
    setAttempt((a) => a + 1)
  }, [])
  return [media, retry]
}
