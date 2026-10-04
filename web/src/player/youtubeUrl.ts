// Turns what people paste into the link box into a YouTube video ID
// (spec 7.4). Anything else is null, and the caller shows a local error.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

/**
 * Accepts watch?v=, youtu.be/, shorts/ and embed/ links, with or without a
 * scheme, and bare 11-character IDs.
 */
export function parseVideoId(input: string): string | null {
  const text = input.trim()
  if (VIDEO_ID.test(text)) return text
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  let id: string | null | undefined
  if (url.hostname === 'youtu.be') {
    id = parts[0]
  } else if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (parts[0] === 'watch') id = url.searchParams.get('v')
    else if (parts[0] === 'shorts' || parts[0] === 'embed') id = parts[1]
  }
  return id && VIDEO_ID.test(id) ? id : null
}
