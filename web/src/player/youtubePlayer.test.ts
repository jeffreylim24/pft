// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_LOAD_FAILED, PlayerState } from './player'
import type { YTNamespace, YTPlayerOptions } from './youtubeApi'
import { YouTubePlayer } from './youtubePlayer'

/** Stands in for YT.Player and records every call. */
class FakeEmbed {
  static all: FakeEmbed[] = []
  readonly element: HTMLElement
  readonly options: YTPlayerOptions
  readonly calls: unknown[][] = []
  state: number = PlayerState.Unstarted

  constructor(element: HTMLElement, options: YTPlayerOptions) {
    this.element = element
    this.options = options
    FakeEmbed.all.push(this)
  }

  cueVideoById(args: { videoId: string; startSeconds?: number }) {
    this.calls.push(['cueVideoById', args])
  }
  playVideo() {
    this.calls.push(['playVideo'])
  }
  pauseVideo() {
    this.calls.push(['pauseVideo'])
  }
  seekTo(seconds: number, allowSeekAhead: boolean) {
    this.calls.push(['seekTo', seconds, allowSeekAhead])
  }
  setVolume(volume: number) {
    this.calls.push(['setVolume', volume])
  }
  getCurrentTime() {
    return 12.5
  }
  getDuration() {
    return 300
  }
  getPlayerState() {
    return this.state
  }
  destroy() {
    this.calls.push(['destroy'])
  }
}

const api = () => Promise.resolve({ Player: FakeEmbed } as unknown as YTNamespace)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function embed(): FakeEmbed {
  const e = FakeEmbed.all.at(-1)
  if (!e) throw new Error('no embed was created')
  return e
}

let host: HTMLElement

beforeEach(() => {
  FakeEmbed.all = []
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  host.remove()
})

describe('YouTubePlayer', () => {
  it('creates an embed inside the host, without YouTube controls', async () => {
    new YouTubePlayer(host, api)
    await flush()
    expect(host.contains(embed().element)).toBe(true)
    expect(embed().options.playerVars).toMatchObject({
      controls: 0,
      disablekb: 1,
      fs: 0,
      iv_load_policy: 3,
      playsinline: 1,
      rel: 0,
      origin: location.origin,
    })
  })

  it('queues commands until the embed is ready, then runs them in order', async () => {
    const p = new YouTubePlayer(host, api)
    p.load('dQw4w9WgXcQ', 12)
    p.play()
    await flush()
    expect(embed().calls).toEqual([])
    embed().options.events.onReady()
    expect(embed().calls).toEqual([['cueVideoById', { videoId: 'dQw4w9WgXcQ', startSeconds: 12 }], ['playVideo']])
    p.seek(30)
    p.pause()
    p.setVolume(40)
    expect(embed().calls.slice(2)).toEqual([['seekTo', 30, true], ['pauseVideo'], ['setVolume', 40]])
  })

  it('reads time, duration and state only once the embed is ready', async () => {
    const p = new YouTubePlayer(host, api)
    await flush()
    expect([p.getCurrentTime(), p.getDuration(), p.getState()]).toEqual([0, 0, PlayerState.Unstarted])
    embed().options.events.onReady()
    embed().state = PlayerState.Paused
    expect([p.getCurrentTime(), p.getDuration(), p.getState()]).toEqual([12.5, 300, PlayerState.Paused])
  })

  it('passes on state changes, errors and blocked autoplay', async () => {
    const p = new YouTubePlayer(host, api)
    const states: number[] = []
    const errors: number[] = []
    let blocked = 0
    p.onStateChange((s) => states.push(s))
    const stopErrors = p.onError((code) => errors.push(code))
    p.onAutoplayBlocked(() => blocked++)
    await flush()
    const { events } = embed().options
    events.onStateChange({ data: PlayerState.Playing })
    events.onError({ data: 150 })
    events.onAutoplayBlocked()
    stopErrors()
    events.onError({ data: 2 })
    expect([states, errors, blocked]).toEqual([[PlayerState.Playing], [150], 1])
  })

  it('reports API_LOAD_FAILED when the IFrame API script fails to load', async () => {
    const p = new YouTubePlayer(host, () => Promise.reject(new Error('blocked')))
    const errors: number[] = []
    p.onError((code) => errors.push(code))
    await flush()
    expect(errors).toEqual([API_LOAD_FAILED])
  })

  it('destroy: before the API arrives nothing is created; after, the embed is destroyed', async () => {
    const early = new YouTubePlayer(host, api)
    early.destroy()
    await flush()
    expect(FakeEmbed.all).toEqual([])
    expect(host.childElementCount).toBe(0)

    const p = new YouTubePlayer(host, api)
    await flush()
    embed().options.events.onReady()
    p.destroy()
    expect(embed().calls).toContainEqual(['destroy'])
    expect(host.childElementCount).toBe(0)
  })
})
