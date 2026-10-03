import { useEffect, useRef, useState } from 'react'

/** A live camera feed. Your own is mirrored, like a selfie camera. */
export function VideoView({ stream, mirrored = false }: { stream: MediaStream; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])
  return <video ref={ref} className={mirrored ? 'video mirrored' : 'video'} autoPlay muted playsInline />
}

/** Stands in for a camera that's off or blocked: the person's initial on their color. */
export function InitialTile({ name, color }: { name: string; color: string }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?'
  return (
    <div className="initial-tile" style={{ background: color }}>
      <span>{initial}</span>
    </div>
  )
}

/** A small bar that moves with the mic's loudness. */
export function MicMeter({ stream }: { stream: MediaStream }) {
  const level = useMicLevel(stream)
  return (
    <div className="mic-meter" role="meter" aria-label="Microphone level" aria-valuenow={Math.round(level * 100)}>
      <div className="mic-meter-fill" style={{ transform: `scaleX(${level})` }} />
    </div>
  )
}

function useMicLevel(stream: MediaStream): number {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (stream.getAudioTracks().length === 0 || typeof AudioContext === 'undefined') return
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    let frame = 0
    const tick = () => {
      analyser.getByteTimeDomainData(samples)
      let peak = 0
      for (const s of samples) peak = Math.max(peak, Math.abs(s - 128))
      setLevel(Math.min(1, peak / 64))
      frame = requestAnimationFrame(tick)
    }
    tick()
    // Browsers may start an AudioContext suspended until the first click.
    const resume = () => void ctx.resume()
    window.addEventListener('pointerdown', resume, { once: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointerdown', resume)
      source.disconnect()
      void ctx.close()
    }
  }, [stream])
  return level
}
