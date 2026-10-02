// Stage coordinates. Everything shared between the two browsers is a
// fraction of the stage (0-1 on each axis), so layouts line up across
// different window sizes. Pixels only exist locally.

export const STAGE_ASPECT = 16 / 9

/** A rectangle in pixels, in whatever coordinate space the caller uses. */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Pos {
  x: number
  y: number
}

/**
 * The largest 16:9 box that fits in an area of the given size, centered,
 * with whole-pixel edges so canvases stay crisp. The area's top-left corner
 * is (0, 0).
 */
export function fitStage(areaWidth: number, areaHeight: number): Box {
  if (!(areaWidth > 0 && areaHeight > 0)) return { left: 0, top: 0, width: 0, height: 0 }
  const width = Math.floor(Math.min(areaWidth, areaHeight * STAGE_ASPECT))
  const height = Math.floor(width / STAGE_ASPECT)
  return {
    left: Math.floor((areaWidth - width) / 2),
    top: Math.floor((areaHeight - height) / 2),
    width,
    height,
  }
}

/**
 * Where a pixel position sits on the stage, as fractions. `p` and `stage`
 * must be in the same space, for example a pointer event's clientX/clientY
 * and the stage element's getBoundingClientRect(). Not clamped: a drag can
 * leave the stage, and the caller decides what that means.
 */
export function toFraction(p: Pos, stage: Box): Pos {
  if (stage.width === 0 || stage.height === 0) return { x: 0, y: 0 }
  return { x: (p.x - stage.left) / stage.width, y: (p.y - stage.top) / stage.height }
}

/** The inverse of toFraction. */
export function toPixels(f: Pos, stage: Box): Pos {
  return { x: stage.left + f.x * stage.width, y: stage.top + f.y * stage.height }
}

export function clampUnit(v: number): number {
  return Math.min(Math.max(v, 0), 1)
}
