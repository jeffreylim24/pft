import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireLocalMedia, releaseLocalMedia } from './media'

function fakeStream(kinds: Array<'video' | 'audio'>) {
  const tracks = kinds.map((kind) => ({ kind, stop: vi.fn() }))
  return {
    tracks,
    stream: {
      getTracks: () => tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    } as unknown as MediaStream,
  }
}

const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
const noCamera = Object.assign(new Error('none'), { name: 'NotFoundError' })

afterEach(() => releaseLocalMedia())

describe('acquireLocalMedia', () => {
  it('opens camera and mic with echo cancellation and noise suppression', async () => {
    const { stream } = fakeStream(['video', 'audio'])
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toEqual({
      status: 'ready',
      stream,
      hasVideo: true,
      hasAudio: true,
    })
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: { echoCancellation: true, noiseSuppression: true } })
  })

  it('falls back to the mic alone when there is no camera', async () => {
    const { stream } = fakeStream(['audio'])
    const getUserMedia = vi.fn().mockRejectedValueOnce(noCamera).mockResolvedValueOnce(stream)
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toMatchObject({ status: 'ready', hasVideo: false })
  })

  it('keeps the mic when only the camera is denied', async () => {
    const { stream } = fakeStream(['audio'])
    const getUserMedia = vi.fn((c: MediaStreamConstraints) => (c.video ? Promise.reject(denied) : Promise.resolve(stream)))
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toEqual({
      status: 'ready',
      stream,
      hasVideo: false,
      hasAudio: true,
    })
  })

  it('keeps the camera when there is no mic', async () => {
    const { stream } = fakeStream(['video'])
    const getUserMedia = vi.fn((c: MediaStreamConstraints) => (c.audio ? Promise.reject(noCamera) : Promise.resolve(stream)))
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toEqual({
      status: 'ready',
      stream,
      hasVideo: true,
      hasAudio: false,
    })
  })

  it('reports blocked when camera and mic are both denied', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(denied)
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toEqual({ status: 'blocked' })
  })

  it('reports unavailable without getUserMedia or without devices', async () => {
    await expect(acquireLocalMedia(undefined)).resolves.toEqual({ status: 'unavailable' })
    releaseLocalMedia()
    await expect(acquireLocalMedia({ getUserMedia: vi.fn().mockRejectedValue(noCamera) })).resolves.toEqual({
      status: 'unavailable',
    })
  })

  it('shares one request between callers (React runs effects twice in development)', async () => {
    const { stream } = fakeStream(['video', 'audio'])
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    const [a, b] = await Promise.all([acquireLocalMedia({ getUserMedia }), acquireLocalMedia({ getUserMedia })])
    expect(a).toBe(b)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('stops every track on release, even if the request was still pending', async () => {
    const { stream, tracks } = fakeStream(['video', 'audio'])
    let resolve!: (s: MediaStream) => void
    acquireLocalMedia({ getUserMedia: () => new Promise((r) => (resolve = r)) })
    releaseLocalMedia()
    resolve(stream)
    await vi.waitFor(() => expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true))
  })
})
