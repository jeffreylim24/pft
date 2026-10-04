import { describe, expect, it } from 'vitest'
import { parseVideoId } from './youtubeUrl'

const ID = 'dQw4w9WgXcQ'

describe('parseVideoId', () => {
  it.each([
    ID,
    `  ${ID}  `,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `http://music.youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=Ab12cD`,
    `youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=10`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
  ])('accepts %s', (input) => {
    expect(parseVideoId(input)).toBe(ID)
  })

  it.each([
    '',
    'hello world',
    'dQw4w9WgXc', // 10 characters
    'dQw4w9WgXcQQ', // 12 characters
    'https://vimeo.com/123456789',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?list=PL123',
    'https://youtu.be/',
    'https://www.youtube.com/@somechannel',
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
  ])('rejects %j', (input) => {
    expect(parseVideoId(input)).toBeNull()
  })
})
