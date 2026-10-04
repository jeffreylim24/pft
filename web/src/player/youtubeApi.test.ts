// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { YTNamespace } from './youtubeApi'

const SRC = 'https://www.youtube.com/iframe_api'
const scripts = () => document.querySelectorAll<HTMLScriptElement>(`script[src="${SRC}"]`)
const fakeYT = () => ({ Player: class {} }) as unknown as YTNamespace

beforeEach(() => {
  vi.resetModules() // a fresh module, so nothing is cached from the last test
  delete window.YT
  delete window.onYouTubeIframeAPIReady
})

afterEach(() => {
  for (const s of scripts()) s.remove()
})

describe('loadYouTubeApi', () => {
  it('adds the script once, and resolves when YouTube says it is ready', async () => {
    const { loadYouTubeApi } = await import('./youtubeApi')
    const first = loadYouTubeApi()
    const second = loadYouTubeApi()
    expect(scripts()).toHaveLength(1)
    const YT = fakeYT()
    window.YT = YT
    window.onYouTubeIframeAPIReady!()
    await expect(first).resolves.toBe(YT)
    await expect(second).resolves.toBe(YT)
  })

  it('resolves at once when the API is already on the page', async () => {
    const YT = fakeYT()
    window.YT = YT
    const { loadYouTubeApi } = await import('./youtubeApi')
    await expect(loadYouTubeApi()).resolves.toBe(YT)
    expect(scripts()).toHaveLength(0)
  })

  it('rejects when the script fails to load, and tries again next time', async () => {
    const { loadYouTubeApi } = await import('./youtubeApi')
    const first = loadYouTubeApi()
    scripts()[0].dispatchEvent(new Event('error'))
    await expect(first).rejects.toThrow('YouTube')
    expect(scripts()).toHaveLength(0)
    void loadYouTubeApi()
    expect(scripts()).toHaveLength(1)
  })
})
