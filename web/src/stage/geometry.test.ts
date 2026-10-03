import { describe, expect, it } from 'vitest'
import { clampUnit, fitStage, toFraction, toPixels } from './geometry'

describe('fitStage', () => {
  it('fills an exactly 16:9 area', () => {
    expect(fitStage(1600, 900)).toEqual({ left: 0, top: 0, width: 1600, height: 900 })
  })

  it('puts bars left and right in a wide area', () => {
    expect(fitStage(2000, 900)).toEqual({ left: 200, top: 0, width: 1600, height: 900 })
  })

  it('puts bars above and below in a tall area', () => {
    expect(fitStage(1600, 1200)).toEqual({ left: 0, top: 150, width: 1600, height: 900 })
  })

  it('rounds down to whole pixels and never overflows the area', () => {
    const box = fitStage(1000, 1000)
    expect(box).toEqual({ left: 0, top: 219, width: 1000, height: 562 })
    for (const [w, h] of [[1366, 705], [1280, 657], [333, 187], [1919, 1001]]) {
      const b = fitStage(w, h)
      expect(b.left + b.width).toBeLessThanOrEqual(w)
      expect(b.top + b.height).toBeLessThanOrEqual(h)
      expect(Math.abs(b.width / b.height - 16 / 9)).toBeLessThan(0.01)
    }
  })

  it('is empty for an area with no room', () => {
    expect(fitStage(0, 500)).toEqual({ left: 0, top: 0, width: 0, height: 0 })
    expect(fitStage(800, -10)).toEqual({ left: 0, top: 0, width: 0, height: 0 })
    expect(fitStage(Number.NaN, 500)).toEqual({ left: 0, top: 0, width: 0, height: 0 })
  })
})

describe('toFraction and toPixels', () => {
  const stage = { left: 200, top: 50, width: 1600, height: 900 }

  it('maps the corners and the center', () => {
    expect(toFraction({ x: 200, y: 50 }, stage)).toEqual({ x: 0, y: 0 })
    expect(toFraction({ x: 1800, y: 950 }, stage)).toEqual({ x: 1, y: 1 })
    expect(toFraction({ x: 1000, y: 500 }, stage)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('does not clamp positions outside the stage', () => {
    expect(toFraction({ x: 0, y: 1400 }, stage)).toEqual({ x: -0.125, y: 1.5 })
  })

  it('round-trips', () => {
    const f = { x: 0.3847, y: 0.1235 }
    const back = toFraction(toPixels(f, stage), stage)
    expect(back.x).toBeCloseTo(f.x, 10)
    expect(back.y).toBeCloseTo(f.y, 10)
  })

  it('lines up across screen sizes: the same fraction lands on the same spot', () => {
    const laptop = { left: 0, top: 0, width: 1280, height: 720 }
    const monitor = { left: 0, top: 0, width: 2560, height: 1440 }
    const f = toFraction({ x: 320, y: 180 }, laptop)
    expect(toPixels(f, monitor)).toEqual({ x: 640, y: 360 })
  })

  it('gives (0, 0) instead of NaN on an empty stage', () => {
    expect(toFraction({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('clampUnit', () => {
  it('keeps values inside [0, 1]', () => {
    expect([-0.2, 0, 0.4, 1, 1.7].map(clampUnit)).toEqual([0, 0, 0.4, 1, 1])
  })
})
