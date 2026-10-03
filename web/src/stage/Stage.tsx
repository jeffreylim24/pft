import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { fitStage, type Box } from './geometry'

/**
 * Fills its parent with letterbox bars and centers the largest 16:9 stage
 * that fits. Children are positioned inside the stage, usually in percent.
 */
export function Stage({ children }: { children?: ReactNode }) {
  const areaRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Box>({ left: 0, top: 0, width: 0, height: 0 })

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    const measure = () => setBox(fitStage(area.clientWidth, area.clientHeight))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={areaRef} className="stage-area">
      <div className="stage" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
        {children}
      </div>
    </div>
  )
}
