// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lobby } from './Lobby'
import { PALETTE } from './prefs'
import { joinRoom } from './session'

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  joinRoom: vi.fn(),
}))

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'
const nameInput = () => screen.getByLabelText<HTMLInputElement>('Your name')

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.mocked(joinRoom).mockClear()
})

afterEach(cleanup)

describe('Lobby', () => {
  it('fills in the remembered name and color', () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: PALETTE[3] }))
    render(<Lobby roomId={roomId} joining={false} />)
    expect(nameInput().value).toBe('Sam')
    expect(screen.getByRole<HTMLInputElement>('radio', { name: `Color ${PALETTE[3]}` }).checked).toBe(true)
  })

  it('needs a name before joining', () => {
    render(<Lobby roomId={roomId} joining={false} />)
    const join = screen.getByRole<HTMLButtonElement>('button', { name: 'Join' })
    expect(join.disabled).toBe(true)
    fireEvent.change(nameInput(), { target: { value: '   ' } })
    expect(join.disabled).toBe(true)
    fireEvent.change(nameInput(), { target: { value: 'Kim' } })
    expect(join.disabled).toBe(false)
  })

  it('joins with the trimmed name and chosen color, and remembers them', () => {
    render(<Lobby roomId={roomId} joining={false} />)
    fireEvent.change(nameInput(), { target: { value: '  Kim  ' } })
    fireEvent.click(screen.getByRole('radio', { name: `Color ${PALETTE[2]}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(joinRoom).toHaveBeenCalledWith(roomId, { name: 'Kim', color: PALETTE[2] })
    expect(JSON.parse(localStorage.getItem('popcorn.profile')!)).toEqual({ name: 'Kim', color: PALETTE[2] })
  })

  it('offers Rejoin after a reload in the same tab', () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: PALETTE[0] }))
    sessionStorage.setItem(`popcorn.resume.${roomId}`, 'tok-1')
    render(<Lobby roomId={roomId} joining={false} />)
    expect(screen.getByRole('heading').textContent).toBe('Welcome back')
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin' }))
    expect(joinRoom).toHaveBeenCalledWith(roomId, { name: 'Sam', color: PALETTE[0] })
  })

  it('shows the initial and still allows joining without a camera', async () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'sam', color: PALETTE[0] }))
    render(<Lobby roomId={roomId} joining={false} />) // jsdom has no getUserMedia
    expect(await screen.findByText('No camera or mic found. You can still join.')).toBeTruthy()
    expect(screen.getByText('S')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join' }).disabled).toBe(false)
  })

  it('shows the headphones tip', () => {
    render(<Lobby roomId={roomId} joining={false} />)
    expect(screen.getByText(/Headphones recommended/)).toBeTruthy()
  })

  it('is busy while joining', () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: PALETTE[0] }))
    render(<Lobby roomId={roomId} joining />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Joining…' }).disabled).toBe(true)
  })
})
