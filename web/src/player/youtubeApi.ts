// The YouTube IFrame API, typed by hand for the few parts the app uses (no
// @types package), and loaded once on demand.

export const IFRAME_API_URL = 'https://www.youtube.com/iframe_api'

export interface YTPlayer {
  cueVideoById(args: { videoId: string; startSeconds?: number }): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  destroy(): void
}

export interface YTPlayerOptions {
  width: string
  height: string
  playerVars: Record<string, string | number>
  events: {
    onReady: () => void
    onStateChange: (event: { data: number }) => void
    onError: (event: { data: number }) => void
    onAutoplayBlocked: () => void
  }
}

export interface YTNamespace {
  Player: new (element: HTMLElement, options: YTPlayerOptions) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let loading: Promise<YTNamespace> | null = null

/** Adds YouTube's script the first time. Later calls share the same promise. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  // YouTube's script defines window.YT early; YT.Player arrives when it's ready.
  if (window.YT?.Player) return Promise.resolve(window.YT)
  loading ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve(window.YT!)
    }
    const script = document.createElement('script')
    script.src = IFRAME_API_URL
    script.async = true
    script.onerror = () => {
      script.remove()
      loading = null // the next call tries again
      reject(new Error("The YouTube player script didn't load"))
    }
    document.head.append(script)
  })
  return loading
}
