import { describe, expect, it, vi } from 'vitest'
import { createRoom } from './api'
import { parseRoute, roomPath } from './routes'

const id = 'Kx81mZq2Tq0Rb2_9sLm0Qa'

describe('parseRoute', () => {
  it.each([
    ['/', { page: 'landing' }],
    [`/r/${id}`, { page: 'room', roomId: id }],
    [`/r/${id}/`, { page: 'room', roomId: id }],
    ['/r/short', { page: 'unknown' }],
    [`/r/${id}x`, { page: 'unknown' }],
    ['/r/', { page: 'unknown' }],
    [`/r/${id}/extra`, { page: 'unknown' }],
    ['/about', { page: 'unknown' }],
  ])('%s', (path, route) => {
    expect(parseRoute(path)).toEqual(route)
  })

  it('round-trips roomPath', () => {
    expect(parseRoute(roomPath(id))).toEqual({ page: 'room', roomId: id })
  })
})

describe('createRoom', () => {
  const reply = (status: number, body: unknown) =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }))

  it('posts to /api/rooms and returns the room ID', async () => {
    const fetchFn = reply(201, { roomId: id })
    await expect(createRoom(fetchFn)).resolves.toBe(id)
    expect(fetchFn).toHaveBeenCalledWith('/api/rooms', { method: 'POST' })
  })

  it('explains a full server', async () => {
    await expect(createRoom(reply(503, 'Too many rooms'))).rejects.toThrow('Too many rooms are open right now')
  })

  it('explains other failures', async () => {
    await expect(createRoom(reply(500, {}))).rejects.toThrow('HTTP 500')
    await expect(createRoom(reply(201, { roomId: '../evil' }))).rejects.toThrow("didn't include a room")
    await expect(createRoom(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')))).rejects.toThrow(
      "Couldn't reach the server",
    )
  })
})
