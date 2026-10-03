// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { navigate } from './routes'

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

describe('App', () => {
  it('creates a room from the landing page and lands in its lobby', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ roomId }), { status: 201 })))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))
    expect(await screen.findByRole('heading', { name: 'Join the watch party' })).toBeTruthy()
    expect(location.pathname).toBe(`/r/${roomId}`)
  })

  it('shows why creating a room failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))
    expect((await screen.findByRole('alert')).textContent).toMatch('Too many rooms')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create room' }).disabled).toBe(false)
  })

  it('follows the Back button', () => {
    render(<App />)
    act(() => navigate(`/r/${roomId}`))
    expect(screen.getByRole('heading', { name: 'Join the watch party' })).toBeTruthy()
    act(() => {
      history.back()
    })
    return vi.waitFor(() => expect(screen.getByRole('button', { name: 'Create room' })).toBeTruthy())
  })

  it('shows Room not found for an unknown path', () => {
    history.replaceState(null, '', '/r/not-a-room')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Room not found' })).toBeTruthy()
  })
})
