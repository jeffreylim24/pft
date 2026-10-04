# Popcorn for Two, Plan 3: Synced YouTube Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two people in a room watch the same YouTube video in sync. Either of them can load, play, pause and seek. Drift is corrected, a stall or ad pauses both people with "Waiting for {name}…" and then resumes, and a reload or dropped connection comes back at the right position.

**Architecture:**
- `src/player/` doesn't depend on `app/`. It contains:
  - the `Player` interface
  - `YouTubePlayer`, a thin wrapper over the IFrame API
  - `FakePlayer`, a clock-driven double used by the tests
  - pure helpers for URLs and timing
  - `PlaybackSync`, a class that drives a `Player` from the room's `PlaybackState`
- `PlaybackSync` follows only the server's broadcast state. It never sends `play`, `pause`, `seek` or `load` itself, only `stalled` and `ready`. Every rule from spec section 7 can therefore be unit-tested with `FakePlayer` and fake timers.
- A small Zustand store, `player/store.ts`, holds facts that never go over the wire: duration, player error, blocked autoplay and volume.
- `app/PlayerLayer.tsx` mounts the player as stage layer 1 and feeds `PlaybackSync` from the room store.
- The toolbar only sends commands.

**Tech Stack:** no new dependencies. React 19.3, zod 4.6.5, Zustand 5.0.15, Vitest 4.1.11, jsdom 29.1.1, @testing-library/react 16.3.3. The YouTube IFrame API is loaded at runtime from `https://www.youtube.com/iframe_api` and typed by hand.

**Spec:** `docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md`:
- Section **7** is the core of this plan.
- Sections 4.3 (`player/`), 5 (stage layers, toolbar), 6 (protocol), 9.4 (failure table) and **13** apply too, especially the "Client (for later plans)" bullets on end of video, reloading and message rate.
- The Go code in `server/internal/room/playback.go` and `server/internal/protocol/` is the real contract.

## Open questions and trade-offs (please decide during review)

1. **No server changes are planned.** The server already does everything section 7 needs:
   - `seek` keeps `playing`.
   - `stalled` and `ready` are ignored when they don't apply.
   - A disconnect auto-pauses only a playing room.
   - The snapshot carries `waitingFor`.

   One trade-off comes with that. On `playback.stalled`, the server pauses at the expected position *now*, which is about 2 seconds past where the stalled player froze (the stall is reported after 2 s with no progress). The stalled person therefore skips about 2 s that their partner saw. Fixing this would mean adding a `position` to `playback.stalled`, which touches the Go struct, the zod schema, the fixture and the reducer. **I recommend leaving it as is**, and this plan does.
2. **A short burst of sound during recovery.** When the room is waiting for this browser (after its own stall, or a reload), the player is allowed to *play* until the video itself moves. Only then does it pause, seek to the room position and send `ready`. That's the only way to wait out a pre-roll ad, and YouTube starts a cued video when you seek it anyway (confirmed in the IFrame API reference). The person being waited for may hear about half a second of audio. Muting during recovery would need `mute`/`unMute` on the `Player` interface. **I recommend accepting the burst for now** and looking at it again after the manual check.
3. **Autoplay in Safari and Firefox is the biggest unknown.** The **Rejoin** or **Join** click happens on our page, not inside YouTube's cross-origin iframe.
   - Chrome passes the gesture through the iframe's `allow="autoplay"`. Safari may not.
   - The plan handles a block in two ways:
     - When YouTube fires `onAutoplayBlocked`, the stage shows "Your browser blocked the video from playing." with a **Start video** button, and the video itself becomes clickable.
     - Meanwhile the stall rule makes the room wait for that person.
   - You don't have Chrome, so only the manual checks in Safari and Firefox will show how this behaves.
4. **A second Zustand store.** CLAUDE.md says only `session.ts` writes `app/store.ts`. This plan leaves that store alone and adds `player/store.ts` for local player facts. The other option is to put them in `app/store.ts` behind setter functions in `session.ts`, which means more plumbing for state that never touches the server.
5. **Volume slider.** It's wired to this browser's YouTube volume and isn't saved across reloads. The partner's voice volume would belong to plan 4. It's easy to drop if you'd rather keep this plan narrower.
6. **`?player=fake` is left for plan 6.** `FakePlayer` is built here and runs in a browser, but the dev-only switch that the end-to-end tests use is part of plan 6.
7. **CLAUDE.md** is untracked in git right now and says `player/` doesn't exist yet. This plan doesn't edit it.

## Plan series

This is plan 3 of 6. Plans 1 and 2 have merged, along with PR #2, which moved the resume token to `localStorage`.

1. Go server (done)
2. Frontend shell (done)
3. **Synced YouTube playback** (this plan)
4. WebRTC call and cam tiles. Uses `acquireLocalMedia()`, `room.polite`, `room.iceServers` and the `signal` messages. Cam tiles go between the player layer and the notices. The autoplay prompt that `PlayerLayer` renders has to stay above them.
5. Cursors and ink. Adds sticky `ink.points` to `applyServerMessage`, with the server's trimming rules.
6. Polish, Playwright end-to-end tests (including the dev-only `?player=fake` switch to `FakePlayer`), a Dockerfile and Fly.io deployment.

## Global Constraints

- **Commands:**
  - Run everything from the repo root: `npm --prefix web …` and `GOTOOLCHAIN=local go -C server …`.
  - npm runs inside `web/`, so test paths are relative to `web/`.
- **Dependencies:**
  - No new npm or Go dependencies.
  - Don't upgrade Vitest (4.1.11) or jsdom (29.1.1). Newer versions don't support Node 25.
  - `golang.org/x/time` stays at v0.15.0.
  - No router, UI kit, CSS framework or `@types/youtube`.
- **TypeScript:**
  - `strict`, `erasableSyntaxOnly` and `noUnusedLocals` are on: no enums and no parameter properties. Use `as const` objects.
  - `noUnusedLocals` also flags private class fields that are never read.
  - App code doesn't see Node types.
- **Ownership:**
  - Only `net/` opens WebSockets.
  - Only `app/session.ts` writes `app/store.ts`.
  - Room state changes only through `applyServerMessage`.
  - `player/` never imports from `app/`.
  - Only `PlaybackSync` and `setMovieVolume` write `player/store.ts`.
- **Server confirms first (spec 7.2):** no code applies a person's own `play`, `pause`, `seek` or `load` locally. The toolbar sends commands, and the player follows the broadcast `playback` state, including on the sender's screen.
- **Spec numbers:**
  - Drift is checked every **2 s**.
  - Seek when the gap is over **1.0 s**.
  - No drift seek within **3 s** of a seek or load.
  - A stall is **more than 2 s** with no progress while the room is playing.
  - Player errors **2, 5, 100, 101 and 150** show "This video can't be played here."
  - `videoId` matches `^[A-Za-z0-9_-]{11}$`.
- **End of video (spec 13):** past the duration, or when the player says "ended", the client never sends `playback.stalled` and never calls `play()`, because YouTube would start the video over. The drift target is clamped to the duration.
- **Stage:** the player is layer 1. Its `iframe` has `pointer-events: none` unless autoplay is blocked. Positions on the stage are fractions.
- **Commits:** Conventional Commits with a scope (`feat(web): …`, `test(web): …`, `docs: …`). Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Decisions made in this plan

Task 9 records these in spec section 13 and adjusts sections 4.3 and 7.3 where they're touched.

1. **Player interface.**
   - Methods: `load(videoId, startSeconds?)`, which *cues* without playing, plus `play`, `pause`, `seek`, `setVolume`, `getCurrentTime`, `getDuration` (0 until known), `getState`, `onStateChange`, `onError`, `onAutoplayBlocked` and `destroy`.
   - It's a superset of the interface in spec 4.3.
2. **Getting ready when the room waits for you.** This covers both after a stall and after a reconnect or reload:
   - The player plays until the video moves on 2 ticks in a row (ticks are 250 ms apart).
   - Then it pauses and seeks to `position`.
   - It sends `playback.ready` once the player is paused within 0.5 s of that position. "Ended" counts as paused, so a room waiting past the end still recovers.
3. **Socket down.** While the connection isn't open, the local player pauses and nothing is sent. After the next `welcome`, the snapshot is applied as new.
4. **Small sync rules:**
   - A paused player more than 0.25 s from the room position is seeked.
   - A player that is cued, unstarted or ended is cued again at the position instead, because seeking it would start it.
   - If YouTube starts playing while the room is paused, the client pauses it again.
   - Drift checks skip a player that isn't reporting "playing".
5. **Blocked autoplay.** The stage shows a **Start video** prompt and the video becomes clickable until it plays.
6. **Controls:**
   - Play and Pause send the room's expected position, clamped to the duration. Play at or after the end sends `0`.
   - The seek bar shows the room time and sends one `playback.seek` when it's released.
   - The time display uses `serverNow()`, not the local player.
   - Load and the link box need an open connection. Play and Seek also need a loaded video, and Seek needs a known duration.
7. **Notices:**
   - "Waiting for {name}…" when the room is waiting for the partner.
   - "Waiting for your video to catch up…" when it's waiting for you.
   - "{name} is reconnecting…" replaces the waiting notice while the partner is away.
   - Errors 2, 5, 100, 101 and 150 show "This video can't be played here."
   - A failed IFrame API script shows "The YouTube player didn't load. Check your connection, then reload the page."
   - Any other code shows "The video player stopped with error {code}."
   - A player error stops stall reports.
8. **Player facts store** (`player/store.ts`). See open question 4.
9. **Volume** is local and not saved. See open question 5.

## Review Focus

1. **The end of a video while the room still says "playing".** The server never stops a room at the end. There must be no stall, pause and resume loop, no restart from 0 (YouTube's `playVideo()` after the end restarts), and a partner who drops after the end must still recover. Tested by:
   - Task 4 `at the end of the video: no restart and no drift seeks`
   - Task 5 `doesn't report a stall at the end of the video`
   - Task 5 `recovers when the room is waiting past the end of the video`
   - Task 7 `play at the end of the video starts again from the beginning`
2. **YouTube starting playback on its own while the room is paused.** A seek on a cued video plays it, and so does a click while the video is clickable. Tested by:
   - Task 4 `pauses a player that starts by itself while the room is paused`
   - Task 4 `cues again instead of seeking a video that hasn't started`
3. **The connection dropping mid-movie.** No `stalled` or `ready` goes out from a dead socket, the local player pauses, and it recovers after the reconnect. Tested by:
   - Task 4 `pauses while disconnected, and catches up on reconnect`
   - Task 5 `sends nothing while disconnected, and recovers after reconnecting`
   - Task 8 `after a dropped connection, the snapshot says the room waits for you, and ready resumes it`
4. **Autoplay blocked on one person's browser.** The room waits for them, and a click brings everyone back. Tested by:
   - Task 5 `blocked autoplay: flags it, and recovers once a click starts the video`
   - Task 6 `offers Start video when autoplay is blocked`
5. **Links as people actually paste them.** These include share links with `?si=`, `&t=42s` or `&list=`, `m.` and `music.` hosts, links without a scheme, surrounding spaces, and look-alike hosts. Tested by the Task 1 `accepts` and `rejects` tables.

---

## File Structure

```
web/src/
  player/                      no imports from app/
    player.ts                  Player interface, PlayerState, Listeners, error codes and messages
    youtubeUrl.ts              parseVideoId(input)
    timing.ts                  expectedPosition, clampToDuration, driftTarget, formatTime, DRIFT_LIMIT_S
    fakePlayer.ts              FakePlayer: clock-driven, copies YouTube's quirks, test controls
    youtubeApi.ts              hand-written IFrame API types, loadYouTubeApi()
    youtubePlayer.ts           YouTubePlayer implements Player
    store.ts                   usePlayerStore (duration, error, autoplayBlocked, volume), setMovieVolume
    sync.ts                    PlaybackSync: apply state, drift, stalls, recovery
    *.test.ts
  app/
    PlayerLayer.tsx            stage layer 1: mounts the player, feeds PlaybackSync, autoplay prompt
    PlayerLayer.test.tsx
    PlaybackControls.tsx       LoadForm, PlaybackControls (play, seek, time), VolumeSlider
    Toolbar.tsx                (modify) uses the three controls above
    Toolbar.test.tsx           (new)
    RoomPage.tsx               (modify) PlayerLayer, placeholder only without a video, notices column, PlaybackNotice
    RoomRoute.test.tsx         (modify) playback notices
    styles.css                 (modify) player layer, notices column, autoplay prompt, load error
  net/
    client.server.test.ts      (modify) playback against the real Go server
docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md   (modify, Task 9)
```

---

### Task 1: Link parsing and playback timing (pure helpers)

**Files:**
- Create: `web/src/player/youtubeUrl.ts`, `web/src/player/timing.ts`
- Test: `web/src/player/youtubeUrl.test.ts`, `web/src/player/timing.test.ts`

**Interfaces:**
- Consumes: the `PlaybackState` type from `web/src/protocol/schemas.ts`.
- Produces:
  - `parseVideoId(input: string): string | null`
  - `DRIFT_LIMIT_S = 1.0`
  - `expectedPosition(pb: Pick<PlaybackState, 'playing' | 'position' | 'updatedAt'>, serverNowMs: number): number`
  - `clampToDuration(position: number, duration: number): number`. A duration of `0` means unknown, so the position is left alone.
  - `driftTarget(current: number, expected: number, duration: number): number | null`. Returns the position to seek to, or `null`.
  - `formatTime(seconds: number): string`, formatted as `m:ss` or `h:mm:ss`.

- [ ] **Step 1: Write the failing tests**

`web/src/player/youtubeUrl.test.ts`:

```ts
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
```

`web/src/player/timing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clampToDuration, driftTarget, expectedPosition, formatTime } from './timing'

const pb = (playing: boolean, position: number, updatedAt: number) => ({ playing, position, updatedAt })

describe('expectedPosition', () => {
  it('holds still while paused', () => {
    expect(expectedPosition(pb(false, 42, 1_000), 99_000)).toBe(42)
  })

  it('moves with the server clock while playing', () => {
    expect(expectedPosition(pb(true, 42, 1_000), 3_500)).toBe(44.5)
  })

  it('never runs backwards when the clocks disagree', () => {
    expect(expectedPosition(pb(true, 42, 5_000), 4_000)).toBe(42)
  })
})

describe('clampToDuration', () => {
  it('clamps to a known duration and leaves the position alone while the duration is unknown', () => {
    expect(clampToDuration(650, 600)).toBe(600)
    expect(clampToDuration(30, 600)).toBe(30)
    expect(clampToDuration(650, 0)).toBe(650)
  })
})

describe('driftTarget', () => {
  it('leaves up to 1 s of drift alone', () => {
    expect(driftTarget(10, 11, 600)).toBeNull()
    expect(driftTarget(11, 10, 600)).toBeNull()
  })

  it('seeks to the expected position beyond 1 s', () => {
    expect(driftTarget(10, 11.5, 600)).toBe(11.5)
    expect(driftTarget(13, 11.5, 0)).toBe(11.5)
  })

  it('clamps to the duration, so a video that has ended is left alone', () => {
    expect(driftTarget(600, 640, 600)).toBeNull()
    expect(driftTarget(590, 640, 600)).toBe(600)
  })
})

describe('formatTime', () => {
  it.each<[number, string]>([
    [0, '0:00'],
    [9.9, '0:09'],
    [61, '1:01'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [-5, '0:00'],
    [Number.NaN, '0:00'],
  ])('%s s is %s', (seconds, text) => {
    expect(formatTime(seconds)).toBe(text)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm --prefix web test -- src/player/youtubeUrl.test.ts src/player/timing.test.ts`
Expected: FAIL, `Failed to resolve import "./youtubeUrl"` and `"./timing"`.

- [ ] **Step 3: Write the helpers**

`web/src/player/youtubeUrl.ts`:

```ts
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
```

`web/src/player/timing.ts`:

```ts
// Playback arithmetic shared by the sync logic and the toolbar (spec 7.1,
// 7.3). Positions are in seconds and clocks are in Unix ms.
import type { PlaybackState } from '../protocol/schemas'

/** Drift beyond this many seconds is corrected with a seek. */
export const DRIFT_LIMIT_S = 1.0

/** Where playback should be at server time serverNowMs. */
export function expectedPosition(
  pb: Pick<PlaybackState, 'playing' | 'position' | 'updatedAt'>,
  serverNowMs: number,
): number {
  if (!pb.playing) return pb.position
  return pb.position + Math.max(serverNowMs - pb.updatedAt, 0) / 1000
}

/** A duration of 0 means it isn't known yet. */
export function clampToDuration(position: number, duration: number): number {
  return duration > 0 ? Math.min(position, duration) : position
}

/**
 * Where to seek a playing player, or null if it's close enough. Clamping
 * to the duration means a video that has ended is left alone (spec 13).
 */
export function driftTarget(current: number, expected: number, duration: number): number | null {
  const target = clampToDuration(expected, duration)
  return Math.abs(current - target) > DRIFT_LIMIT_S ? target : null
}

/** 61 → "1:01", 3725 → "1:02:05". */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npm --prefix web test -- src/player/youtubeUrl.test.ts src/player/timing.test.ts`
Expected: PASS, `Tests  38 passed (38)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/youtubeUrl.ts web/src/player/youtubeUrl.test.ts web/src/player/timing.ts web/src/player/timing.test.ts
git commit -m "feat(web): parse YouTube links and compute playback timing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Player interface and FakePlayer

**Files:**
- Create: `web/src/player/player.ts`, `web/src/player/fakePlayer.ts`
- Test: `web/src/player/fakePlayer.test.ts`

**Interfaces:**
- Produces (`player.ts`):
  - `PlayerState = { Unstarted: -1, Ended: 0, Playing: 1, Paused: 2, Buffering: 3, Cued: 5 } as const`. The values are YouTube's own.
  - `type PlayerStateValue`
  - `interface Player`, with:
    - commands: `load(videoId, startSeconds?)`, `play()`, `pause()`, `seek(seconds)`, `setVolume(0-100)`
    - reads: `getCurrentTime()`, `getDuration()`, `getState()`
    - events, each returning an unsubscribe function: `onStateChange(cb)`, `onError(cb)`, `onAutoplayBlocked(cb)`
    - `destroy()`
  - `class Listeners<T extends unknown[]>` with `add(listener): () => void` and `emit(...args)`.
  - `UNPLAYABLE_ERRORS = [2, 5, 100, 101, 150]`, `API_LOAD_FAILED = -1` and `playerErrorMessage(code): string`.
- Produces (`fakePlayer.ts`): `class FakePlayer implements Player`, built with `new FakePlayer({ videoDuration?, now? })`.
  - Public fields:
    - `calls: string[]`, holding entries like `'load:<id>@<start>'`, `'play'`, `'pause'` and `'seek:<s>'`, with numbers rounded to 0.01
    - `videoId`, `volume`, `destroyed`
  - Test controls: `stall()`, `unstall()`, `skew(seconds)`, `blockAutoplay(blocked = true)` and `fail(code)`.
  - Quirks copied from YouTube:
    - `load` cues without playing.
    - The duration is `0` until the video first plays.
    - `seek` from any state except Paused or Playing starts playback.
    - `play()` after the end starts over at 0.
    - Reaching the duration reports `Ended`.

- [ ] **Step 1: Write the failing test**

`web/src/player/fakePlayer.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { FakePlayer } from './fakePlayer'
import { PlayerState } from './player'

const ID = 'dQw4w9WgXcQ'
let now = 0
const make = () => new FakePlayer({ videoDuration: 100, now: () => now })

beforeEach(() => {
  now = 0
})

describe('FakePlayer', () => {
  it('cues without playing; once playing, time follows the clock and the duration is known', () => {
    const p = make()
    p.load(ID, 10)
    expect([p.getState(), p.getCurrentTime(), p.getDuration()]).toEqual([PlayerState.Cued, 10, 0])
    now += 5_000
    expect(p.getCurrentTime()).toBe(10)
    p.play()
    now += 2_000
    expect([p.getState(), p.getCurrentTime(), p.getDuration()]).toEqual([PlayerState.Playing, 12, 100])
    expect(p.calls).toEqual([`load:${ID}@10`, 'play'])
  })

  it('pause freezes the time, and a seek while paused stays paused', () => {
    const p = make()
    p.load(ID)
    p.play()
    now += 3_000
    p.pause()
    now += 3_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Paused, 3])
    p.seek(50)
    now += 1_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Paused, 50])
  })

  it('seeking a cued video starts it playing, like YouTube', () => {
    const p = make()
    const states: number[] = []
    p.onStateChange((s) => states.push(s))
    p.load(ID)
    p.seek(20)
    now += 1_000
    expect(states).toEqual([PlayerState.Cued, PlayerState.Playing])
    expect(p.getCurrentTime()).toBe(21)
  })

  it('stall() stops the time while it still says playing; skew() nudges it', () => {
    const p = make()
    p.load(ID)
    p.play()
    now += 1_000
    p.stall()
    now += 5_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Playing, 1])
    p.unstall()
    now += 1_000
    expect(p.getCurrentTime()).toBe(2)
    p.skew(-0.5)
    expect(p.getCurrentTime()).toBe(1.5)
  })

  it('ends at the duration, and play() after the end starts over', () => {
    const p = make()
    p.load(ID, 95)
    p.play()
    now += 10_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Ended, 100])
    p.play()
    now += 1_000
    expect([p.getState(), p.getCurrentTime()]).toEqual([PlayerState.Playing, 1])
  })

  it('blocked autoplay: play() reports it and does nothing; fail() reports an error', () => {
    const p = make()
    let blocked = 0
    const errors: number[] = []
    p.onAutoplayBlocked(() => blocked++)
    p.onError((code) => errors.push(code))
    p.blockAutoplay()
    p.load(ID)
    p.play()
    expect([blocked, p.getState()]).toEqual([1, PlayerState.Cued])
    p.fail(150)
    expect(errors).toEqual([150])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm --prefix web test -- src/player/fakePlayer.test.ts`
Expected: FAIL, `Failed to resolve import "./fakePlayer"`.

- [ ] **Step 3: Write the interface and the fake**

`web/src/player/player.ts`:

```ts
// The video player, behind an interface so the sync logic can be tested
// with FakePlayer instead of a real YouTube embed (spec 4.3).

/** YouTube's player states, which FakePlayer uses too. */
export const PlayerState = {
  Unstarted: -1,
  Ended: 0,
  Playing: 1,
  Paused: 2,
  Buffering: 3,
  Cued: 5,
} as const
export type PlayerStateValue = (typeof PlayerState)[keyof typeof PlayerState]

export interface Player {
  /** Shows a video at startSeconds without playing it. */
  load(videoId: string, startSeconds?: number): void
  play(): void
  pause(): void
  seek(seconds: number): void
  /** 0 to 100, this browser only. */
  setVolume(volume: number): void
  getCurrentTime(): number
  /** 0 until the video's metadata has loaded. */
  getDuration(): number
  getState(): PlayerStateValue
  /** Each on* method returns a function that removes the listener. */
  onStateChange(listener: (state: PlayerStateValue) => void): () => void
  onError(listener: (code: number) => void): () => void
  /** The browser refused to start playback without a click. */
  onAutoplayBlocked(listener: () => void): () => void
  destroy(): void
}

/** A set of callbacks, for the on* methods above. */
export class Listeners<T extends unknown[]> {
  private readonly set = new Set<(...args: T) => void>()

  add(listener: (...args: T) => void): () => void {
    this.set.add(listener)
    return () => this.set.delete(listener)
  }

  emit(...args: T): void {
    for (const listener of [...this.set]) listener(...args)
  }
}

/** YouTube errors meaning the video can't be shown in an embed (spec 7.4). */
export const UNPLAYABLE_ERRORS: readonly number[] = [2, 5, 100, 101, 150]
/** Our own code: the IFrame API script didn't load. */
export const API_LOAD_FAILED = -1

export function playerErrorMessage(code: number): string {
  if (UNPLAYABLE_ERRORS.includes(code)) return "This video can't be played here."
  if (code === API_LOAD_FAILED) return "The YouTube player didn't load. Check your connection, then reload the page."
  return `The video player stopped with error ${code}.`
}
```

`web/src/player/fakePlayer.ts`:

```ts
// A Player with no YouTube behind it. Its time follows a clock (Date.now
// unless told otherwise, so Vitest's fake timers move it), and it copies the
// YouTube quirks the sync logic has to cope with. Unit tests drive it
// directly. Plan 6's end-to-end tests will run the app with it.
import { Listeners, PlayerState, type Player, type PlayerStateValue } from './player'

export interface FakePlayerOptions {
  /** The duration every video reports once it starts playing. Default 600. */
  videoDuration?: number
  now?: () => number
}

export class FakePlayer implements Player {
  /** Every command in order: 'load:<id>@<start>', 'play', 'pause', 'seek:<s>'. */
  readonly calls: string[] = []
  videoId: string | null = null
  volume = 100
  destroyed = false
  private state: PlayerStateValue = PlayerState.Unstarted
  private base = 0 // the player's time when `since` was taken
  private since = 0 // clock ms
  private duration = 0
  private frozen = false
  private autoplayAllowed = true
  private readonly videoDuration: number
  private readonly now: () => number
  private readonly stateListeners = new Listeners<[PlayerStateValue]>()
  private readonly errorListeners = new Listeners<[number]>()
  private readonly blockedListeners = new Listeners<[]>()

  constructor(opts: FakePlayerOptions = {}) {
    this.videoDuration = opts.videoDuration ?? 600
    this.now = opts.now ?? (() => Date.now())
  }

  load(videoId: string, startSeconds = 0): void {
    this.calls.push(`load:${videoId}@${round(startSeconds)}`)
    this.videoId = videoId
    this.duration = 0
    this.frozen = false
    this.setTime(startSeconds)
    this.setState(PlayerState.Cued)
  }

  play(): void {
    this.calls.push('play')
    // Like YouTube: playing a video that has ended starts it over.
    this.start(this.state === PlayerState.Ended ? 0 : this.getCurrentTime())
  }

  pause(): void {
    this.calls.push('pause')
    if (this.state !== PlayerState.Playing) return
    this.setTime(this.getCurrentTime())
    this.setState(PlayerState.Paused)
  }

  seek(seconds: number): void {
    this.calls.push(`seek:${round(seconds)}`)
    const to = this.duration > 0 ? Math.min(seconds, this.duration) : seconds
    this.setTime(to)
    // Like YouTube: a seek from any state but paused or playing starts playback.
    if (this.state !== PlayerState.Paused && this.state !== PlayerState.Playing) this.start(to)
  }

  setVolume(volume: number): void {
    this.volume = volume
  }

  getCurrentTime(): number {
    const running = this.state === PlayerState.Playing && !this.frozen
    const t = running ? this.base + (this.now() - this.since) / 1000 : this.base
    return this.duration > 0 ? Math.min(t, this.duration) : t
  }

  getDuration(): number {
    return this.duration
  }

  getState(): PlayerStateValue {
    if (this.state === PlayerState.Playing && this.duration > 0 && this.getCurrentTime() >= this.duration) {
      this.setTime(this.duration)
      this.setState(PlayerState.Ended)
    }
    return this.state
  }

  onStateChange(listener: (state: PlayerStateValue) => void): () => void {
    return this.stateListeners.add(listener)
  }

  onError(listener: (code: number) => void): () => void {
    return this.errorListeners.add(listener)
  }

  onAutoplayBlocked(listener: () => void): () => void {
    return this.blockedListeners.add(listener)
  }

  destroy(): void {
    this.destroyed = true
  }

  // ---- driven by tests ----

  /** Time stops while the player still says it's playing, as during an ad. */
  stall(): void {
    this.setTime(this.getCurrentTime())
    this.frozen = true
  }

  unstall(): void {
    this.frozen = false
    this.since = this.now()
  }

  /** Moves the time without a command, as if the player ran fast or slow. */
  skew(seconds: number): void {
    this.setTime(this.getCurrentTime() + seconds)
  }

  blockAutoplay(blocked = true): void {
    this.autoplayAllowed = !blocked
  }

  fail(code: number): void {
    this.errorListeners.emit(code)
  }

  private start(from: number): void {
    if (!this.autoplayAllowed) {
      this.blockedListeners.emit()
      return
    }
    if (this.duration === 0) this.duration = this.videoDuration
    this.setTime(from)
    this.setState(PlayerState.Playing) // last, because a listener may pause at once
  }

  private setTime(seconds: number): void {
    this.base = seconds
    this.since = this.now()
  }

  private setState(state: PlayerStateValue): void {
    if (state === this.state) return
    this.state = state
    this.stateListeners.emit(state)
  }
}

const round = (n: number) => Math.round(n * 100) / 100
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm --prefix web test -- src/player/fakePlayer.test.ts`
Expected: PASS, `Tests  6 passed (6)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/player.ts web/src/player/fakePlayer.ts web/src/player/fakePlayer.test.ts
git commit -m "feat(web): add the Player interface and a clock-driven FakePlayer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: YouTubePlayer over the IFrame API

**Files:**
- Create: `web/src/player/youtubeApi.ts`, `web/src/player/youtubePlayer.ts`
- Test: `web/src/player/youtubeApi.test.ts`, `web/src/player/youtubePlayer.test.ts`

**Interfaces:**
- Consumes: `Player`, `PlayerState`, `Listeners` and `API_LOAD_FAILED` (Task 2).
- Produces (`youtubeApi.ts`):
  - `IFRAME_API_URL`
  - the types `YTPlayer`, `YTPlayerOptions` and `YTNamespace`
  - a `Window` augmentation for `YT` and `onYouTubeIframeAPIReady`
  - `loadYouTubeApi(): Promise<YTNamespace>`. It adds the script once, rejects if the script fails, and tries again on the next call after a failure.
- Produces (`youtubePlayer.ts`): `class YouTubePlayer implements Player`, built with `new YouTubePlayer(host: HTMLElement, loadApi = loadYouTubeApi)`.
  - It appends its own `div` to `host` and lets YouTube replace that `div` with the iframe.
  - Commands are queued until `onReady` and then run in order.
  - Reads return `0` or `Unstarted` until the player is ready.
  - `load` calls `cueVideoById({videoId, startSeconds})`, and `seek` calls `seekTo(s, true)`.
  - If the script fails to load, it emits `onError(API_LOAD_FAILED)`.
  - `destroy()` works before the API has arrived (React StrictMode mounts twice in dev), and it empties `host`.

- [ ] **Step 1: Write the failing tests**

`web/src/player/youtubeApi.test.ts`:

```ts
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
```

`web/src/player/youtubePlayer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm --prefix web test -- src/player/youtubeApi.test.ts src/player/youtubePlayer.test.ts`
Expected: FAIL, `Failed to resolve import "./youtubeApi"` and `"./youtubePlayer"`.

- [ ] **Step 3: Write the loader and the player**

`web/src/player/youtubeApi.ts`:

```ts
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
```

`web/src/player/youtubePlayer.ts`:

```ts
// The Player interface on top of the YouTube IFrame API. The app draws its
// own controls (spec 5), so the embed shows none and has no keyboard
// shortcuts. CSS keeps the pointer off it.
import { API_LOAD_FAILED, Listeners, PlayerState, type Player, type PlayerStateValue } from './player'
import { loadYouTubeApi, type YTNamespace, type YTPlayer } from './youtubeApi'

const PLAYER_VARS = { controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0 }

export class YouTubePlayer implements Player {
  private readonly host: HTMLElement
  private embed: YTPlayer | null = null
  private ready = false
  private destroyed = false
  private queue: Array<(yt: YTPlayer) => void> = [] // commands sent before onReady
  private readonly stateListeners = new Listeners<[PlayerStateValue]>()
  private readonly errorListeners = new Listeners<[number]>()
  private readonly blockedListeners = new Listeners<[]>()

  constructor(host: HTMLElement, loadApi: () => Promise<YTNamespace> = loadYouTubeApi) {
    this.host = host
    // YouTube replaces this element with its iframe. It's ours, not React's.
    const target = document.createElement('div')
    host.append(target)
    loadApi().then(
      (YT) => {
        if (this.destroyed) return
        this.embed = new YT.Player(target, {
          width: '100%',
          height: '100%',
          playerVars: { ...PLAYER_VARS, origin: location.origin },
          events: {
            onReady: () => this.becameReady(),
            onStateChange: (e) => this.stateListeners.emit(e.data as PlayerStateValue),
            onError: (e) => this.errorListeners.emit(e.data),
            onAutoplayBlocked: () => this.blockedListeners.emit(),
          },
        })
      },
      () => {
        if (!this.destroyed) this.errorListeners.emit(API_LOAD_FAILED)
      },
    )
  }

  load(videoId: string, startSeconds = 0): void {
    this.run((yt) => yt.cueVideoById({ videoId, startSeconds }))
  }

  play(): void {
    this.run((yt) => yt.playVideo())
  }

  pause(): void {
    this.run((yt) => yt.pauseVideo())
  }

  seek(seconds: number): void {
    this.run((yt) => yt.seekTo(seconds, true))
  }

  setVolume(volume: number): void {
    this.run((yt) => yt.setVolume(volume))
  }

  getCurrentTime(): number {
    return (this.ready && this.embed?.getCurrentTime()) || 0
  }

  getDuration(): number {
    return (this.ready && this.embed?.getDuration()) || 0
  }

  getState(): PlayerStateValue {
    if (!this.ready || !this.embed) return PlayerState.Unstarted
    return this.embed.getPlayerState() as PlayerStateValue
  }

  onStateChange(listener: (state: PlayerStateValue) => void): () => void {
    return this.stateListeners.add(listener)
  }

  onError(listener: (code: number) => void): () => void {
    return this.errorListeners.add(listener)
  }

  onAutoplayBlocked(listener: () => void): () => void {
    return this.blockedListeners.add(listener)
  }

  destroy(): void {
    this.destroyed = true
    this.ready = false
    this.queue = []
    this.embed?.destroy()
    this.embed = null
    this.host.replaceChildren()
  }

  private becameReady(): void {
    if (this.destroyed || !this.embed) return
    this.ready = true
    for (const command of this.queue.splice(0)) command(this.embed)
  }

  private run(command: (yt: YTPlayer) => void): void {
    if (this.ready && this.embed) command(this.embed)
    else this.queue.push(command)
  }
}
```

- [ ] **Step 4: Run them to see them pass, then typecheck**

Run: `npm --prefix web test -- src/player/youtubeApi.test.ts src/player/youtubePlayer.test.ts && npm --prefix web run typecheck`
Expected: PASS, `Tests  9 passed (9)`. The typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/youtubeApi.ts web/src/player/youtubeApi.test.ts web/src/player/youtubePlayer.ts web/src/player/youtubePlayer.test.ts
git commit -m "feat(web): wrap the YouTube IFrame API behind the Player interface

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: PlaybackSync, following the room and correcting drift

**Files:**
- Create: `web/src/player/store.ts`, `web/src/player/sync.ts`
- Test: `web/src/player/sync.test.ts`

**Interfaces:**
- Consumes:
  - `Player`, `PlayerState` and `FakePlayer` (Task 2)
  - `expectedPosition`, `clampToDuration`, `driftTarget` and `DRIFT_LIMIT_S` (Task 1)
  - the `ClientMessage` and `PlaybackState` types
- Produces (`store.ts`):
  - `interface PlayerFacts { duration: number; error: number | null; autoplayBlocked: boolean; volume: number }`
  - `initialPlayerFacts`, `usePlayerStore` and `setMovieVolume(volume)`, which clamps to 0–100
- Produces (`sync.ts`):
  - `interface SyncInput { playback: PlaybackState; you: string; connected: boolean }`
  - `interface PlaybackSyncDeps { player: Player; send: (msg: ClientMessage) => boolean; serverNow: () => number }`
  - `class PlaybackSync`, built with `new PlaybackSync(deps)`, with `update(input: SyncInput): void` and `destroy(): void`
  - the constants `TICK_MS = 250`, `DRIFT_CHECK_MS = 2000`, `SEEK_GRACE_MS = 3000` and `PAUSED_TOLERANCE_S = 0.25`
- Behavior:
  - `update` acts only when `playback` (by reference), `you` or `connected` changes.
  - On a new state, it loads (cues) a new video at the expected position and then:
    - **playing:** seeks if more than 1 s off, then plays, unless the expected position is past the duration.
    - **paused:** pauses, and seeks if more than 0.25 s off (it cues again instead if the video hasn't started or has ended).
  - It pauses the player whenever the player reports Playing or Buffering while the room doesn't want playback.
  - While disconnected, it pauses once and does nothing else.
  - Every 2 s it runs a drift check (`driftTarget`), skipping the check within 3 s of its own load or seek, or when the player isn't Playing.
  - Each tick reports the duration to the store.
  - It applies the store's volume to the player.
  - `send` is accepted here but first used in Task 5.

- [ ] **Step 1: Write the failing test**

`web/src/player/sync.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { FakePlayer } from './fakePlayer'
import { PlayerState } from './player'
import { initialPlayerFacts, setMovieVolume, usePlayerStore } from './store'
import { PlaybackSync } from './sync'

const VIDEO = 'dQw4w9WgXcQ'
const OFFSET = 5_000 // the server's clock runs 5 s ahead of ours
let player: FakePlayer
let sent: ClientMessage[]
let sync: PlaybackSync

const serverNow = () => Date.now() + OFFSET

/** A playback state stamped with the current server time. */
function state(changes: Partial<PlaybackState> = {}): PlaybackState {
  return {
    videoId: VIDEO,
    playing: false,
    position: 0,
    updatedAt: serverNow(),
    waitingFor: null,
    autoResume: false,
    ...changes,
  }
}

function apply(playback: PlaybackState, connected = true) {
  sync.update({ playback, you: 'me', connected })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  usePlayerStore.setState(initialPlayerFacts)
  player = new FakePlayer({ videoDuration: 600 })
  sent = []
  sync = new PlaybackSync({
    player,
    send: (msg) => {
      sent.push(msg)
      return true
    },
    serverNow,
  })
})

afterEach(() => {
  sync.destroy()
  vi.useRealTimers()
})

describe('PlaybackSync: following the room', () => {
  it('cues the room video at its paused position without playing it', () => {
    apply(state({ position: 42 }))
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause'])
    expect(player.getState()).toBe(PlayerState.Cued)
  })

  it('joins a playing room at the expected position, using the server clock', () => {
    apply(state({ playing: true, position: 10, updatedAt: serverNow() - 3_000 }))
    expect(player.calls).toEqual([`load:${VIDEO}@13`, 'play'])
    expect(player.getState()).toBe(PlayerState.Playing)
  })

  it('plays and pauses only when the broadcast says so', () => {
    apply(state())
    apply(state({ playing: true }))
    vi.advanceTimersByTime(5_000)
    apply(state({ position: 5 }))
    expect(player.calls).toEqual([`load:${VIDEO}@0`, 'pause', 'play', 'pause'])
    expect([player.getState(), player.getCurrentTime()]).toEqual([PlayerState.Paused, 5])
  })

  it('seeks when a seek arrives, while playing or paused', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(5_000)
    apply(state({ playing: true, position: 60 }))
    expect(player.calls).toEqual([`load:${VIDEO}@0`, 'play', 'seek:60', 'play'])
    apply(state({ position: 30 }))
    expect(player.calls.slice(4)).toEqual(['pause', 'seek:30'])
    expect([player.getState(), player.getCurrentTime()]).toEqual([PlayerState.Paused, 30])
  })

  it("cues again instead of seeking a video that hasn't started", () => {
    apply(state({ position: 42 }))
    apply(state({ position: 100 }))
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause', 'pause', `load:${VIDEO}@100`])
    expect(player.getState()).toBe(PlayerState.Cued)
  })

  it('corrects drift over 1 s every 2 s, but not within 3 s of a seek or load', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(2_500) // the check at 2 s is within 3 s of the load
    player.skew(-1.5)
    vi.advanceTimersByTime(1_500) // the check at 4 s finds the player 1.5 s behind
    expect(player.calls.filter((c) => c.startsWith('seek'))).toEqual(['seek:4'])
    player.skew(-0.8)
    vi.advanceTimersByTime(4_000) // 6 s is too soon after that seek; at 8 s, 0.8 s is fine
    expect(player.calls.filter((c) => c.startsWith('seek'))).toEqual(['seek:4'])
  })

  it('pauses a player that starts by itself while the room is paused', () => {
    apply(state({ position: 42 }))
    player.play() // e.g. a click on the video, or YouTube playing a seeked cued video
    expect(player.getState()).toBe(PlayerState.Paused)
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause', 'play', 'pause'])
  })

  it('at the end of the video: no restart and no drift seeks', () => {
    const startedAt = serverNow()
    apply(state({ playing: true, position: 590, updatedAt: startedAt }))
    vi.advanceTimersByTime(15_000)
    expect(player.getState()).toBe(PlayerState.Ended)
    // The same state again (a reconnect, say) must not call play(): YouTube would start over.
    apply(state({ playing: true, position: 590, updatedAt: startedAt }))
    expect(player.calls).toEqual([`load:${VIDEO}@590`, 'play'])
  })

  it('pauses while disconnected, and catches up on reconnect', () => {
    const playing = state({ playing: true })
    apply(playing)
    vi.advanceTimersByTime(3_000)
    apply(playing, false)
    expect(player.getState()).toBe(PlayerState.Paused)
    vi.advanceTimersByTime(5_000)
    apply(playing, true)
    expect(player.calls).toEqual([`load:${VIDEO}@0`, 'play', 'pause', 'seek:8', 'play'])
  })

  it('ignores updates that leave playback unchanged', () => {
    const paused = state({ position: 42 })
    apply(paused)
    apply(paused)
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause'])
  })

  it('applies the volume slider to the player', () => {
    setMovieVolume(30)
    expect(player.volume).toBe(30)
    setMovieVolume(150)
    expect(player.volume).toBe(100)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm --prefix web test -- src/player/sync.test.ts`
Expected: FAIL, `Failed to resolve import "./store"`.

- [ ] **Step 3: Write the store and the sync**

`web/src/player/store.ts`:

```ts
// Facts about this browser's player that never go over the wire. Room state
// stays in app/store.ts. PlaybackSync writes these, and setMovieVolume
// writes the volume for the toolbar slider.
import { create } from 'zustand'

export interface PlayerFacts {
  /** Seconds. 0 until the player knows. */
  duration: number
  /** The player's last error code, until the next video loads. */
  error: number | null
  /** The browser refused to start playback without a click. */
  autoplayBlocked: boolean
  /** 0 to 100. Local only, and not saved. */
  volume: number
}

export const initialPlayerFacts: PlayerFacts = { duration: 0, error: null, autoplayBlocked: false, volume: 100 }

export const usePlayerStore = create<PlayerFacts>()(() => initialPlayerFacts)

export function setMovieVolume(volume: number): void {
  usePlayerStore.setState({ volume: Math.min(Math.max(volume, 0), 100) })
}
```

`web/src/player/sync.ts`:

```ts
// Keeps this browser's player in step with the room (spec section 7). It
// follows only the server's broadcast state, never a person's command, so
// both browsers act on the same thing. It also corrects drift.
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { PlayerState, type Player, type PlayerStateValue } from './player'
import { usePlayerStore } from './store'
import { clampToDuration, DRIFT_LIMIT_S, driftTarget, expectedPosition } from './timing'

/** How often the player is sampled. */
export const TICK_MS = 250
export const DRIFT_CHECK_MS = 2_000
/** No drift seeks this soon after our own load or seek. */
export const SEEK_GRACE_MS = 3_000
/** How far a paused player may sit from the room position. */
export const PAUSED_TOLERANCE_S = 0.25

export interface SyncInput {
  playback: PlaybackState
  you: string
  connected: boolean
}

export interface PlaybackSyncDeps {
  player: Player
  send: (msg: ClientMessage) => boolean
  serverNow: () => number
}

export class PlaybackSync {
  private readonly player: Player
  private readonly serverNow: () => number
  private readonly cleanups: Array<() => void> = []
  private input: SyncInput | null = null
  private loadedVideoId: string | null = null
  private lastSeekAt = -Infinity // local ms of our last load or seek

  constructor({ player, serverNow }: PlaybackSyncDeps) {
    this.player = player
    this.serverNow = serverNow
    usePlayerStore.setState({ duration: 0, error: null, autoplayBlocked: false })
    player.setVolume(usePlayerStore.getState().volume)
    const tick = setInterval(() => this.tick(), TICK_MS)
    const drift = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS)
    this.cleanups.push(
      () => clearInterval(tick),
      () => clearInterval(drift),
      player.onStateChange((state) => this.playerStateChanged(state)),
      player.onError((code) => usePlayerStore.setState({ error: code })),
      player.onAutoplayBlocked(() => usePlayerStore.setState({ autoplayBlocked: true })),
      usePlayerStore.subscribe((facts, prev) => {
        if (facts.volume !== prev.volume) player.setVolume(facts.volume)
      }),
    )
  }

  /** Called on every store change. Acts only when something relevant changed. */
  update(next: SyncInput): void {
    const prev = this.input
    this.input = next
    if (!next.connected) {
      // While we're away the server pauses the partner, so stop here too.
      if (prev?.connected !== false) this.player.pause()
      return
    }
    if (!prev?.connected || prev.playback !== next.playback || prev.you !== next.you) this.apply()
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  // Makes the player match a new room state.
  private apply(): void {
    const { playback } = this.input!
    if (playback.videoId === null) return
    const justLoaded = playback.videoId !== this.loadedVideoId
    if (justLoaded) {
      this.loadedVideoId = playback.videoId
      usePlayerStore.setState({ duration: 0, error: null, autoplayBlocked: false })
      this.cue(playback.videoId, expectedPosition(playback, this.serverNow()))
    }
    const target = this.target()
    if (playback.playing) {
      if (!justLoaded && Math.abs(this.player.getCurrentTime() - target) > DRIFT_LIMIT_S) this.seek(target)
      // play() after the end would start the video over (spec 13).
      if (!this.expectedPastEnd()) this.player.play()
    } else {
      this.player.pause()
      if (!justLoaded && Math.abs(this.player.getCurrentTime() - target) > PAUSED_TOLERANCE_S) {
        this.moveWhilePaused(playback.videoId, target)
      }
    }
  }

  private tick(): void {
    const duration = this.player.getDuration()
    if (duration !== usePlayerStore.getState().duration) usePlayerStore.setState({ duration })
  }

  private checkDrift(): void {
    const input = this.input
    if (!input?.connected || !input.playback.playing || input.playback.videoId === null) return
    if (usePlayerStore.getState().error !== null || Date.now() - this.lastSeekAt < SEEK_GRACE_MS) return
    // Seeking a player that is buffering, or has ended, doesn't help.
    if (this.player.getState() !== PlayerState.Playing) return
    const expected = expectedPosition(input.playback, this.serverNow())
    const target = driftTarget(this.player.getCurrentTime(), expected, this.player.getDuration())
    if (target !== null) this.seek(target)
  }

  // YouTube can start playing on its own: a seek on a cued video does, and
  // so does a click while the video is clickable. Undo that if the room
  // doesn't want playback.
  private playerStateChanged(state: PlayerStateValue): void {
    if (state === PlayerState.Playing) usePlayerStore.setState({ autoplayBlocked: false })
    const input = this.input
    if (!input || input.playback.videoId === null) return
    const wantsPlaying = input.connected && input.playback.playing
    if (!wantsPlaying && (state === PlayerState.Playing || state === PlayerState.Buffering)) this.player.pause()
  }

  // Seeking a video that hasn't started, or has ended, would start it
  // playing, so cue it again at the new spot instead.
  private moveWhilePaused(videoId: string, target: number): void {
    const state = this.player.getState()
    if (state === PlayerState.Paused || state === PlayerState.Playing || state === PlayerState.Buffering) {
      this.seek(target)
    } else {
      this.cue(videoId, target)
    }
  }

  private cue(videoId: string, start: number): void {
    this.player.load(videoId, start)
    this.lastSeekAt = Date.now()
  }

  private seek(seconds: number): void {
    this.player.seek(seconds)
    this.lastSeekAt = Date.now()
  }

  /** Where the player should be now, within the video. */
  private target(): number {
    return clampToDuration(expectedPosition(this.input!.playback, this.serverNow()), this.player.getDuration())
  }

  private expectedPastEnd(): boolean {
    const duration = this.player.getDuration()
    return duration > 0 && expectedPosition(this.input!.playback, this.serverNow()) >= duration
  }
}
```

- [ ] **Step 4: Run it to see it pass, then typecheck**

Run: `npm --prefix web test -- src/player/sync.test.ts && npm --prefix web run typecheck`
Expected: PASS, `Tests  11 passed (11)`. The typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/store.ts web/src/player/sync.ts web/src/player/sync.test.ts
git commit -m "feat(web): drive the player from the room's playback state, with drift correction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Stalls, getting ready, errors and blocked autoplay

**Files:**
- Modify: `web/src/player/sync.ts` (the complete new version is below)
- Test: `web/src/player/sync.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: the same public API as Task 4, plus the constants `STALL_MS = 2000`, `READY_TOLERANCE_S = 0.5` and `PROGRESS_TICKS = 2`. New behavior:
  - **Stall.** It sends `playback.stalled` **once** per room state when all of these hold:
    - the room is playing
    - the player's time hasn't moved for more than 2 s
    - there's no player error
    - the player hasn't ended, and the expected position isn't past the duration
    - the connection is open
  - **Getting ready.** Recovery runs when `waitingFor === you && autoResume`:
    1. Call `play()`.
    2. Wait until the time moves on 2 consecutive ticks while the player is Playing. If the player reports Ended, skip straight to step 4.
    3. `pause()`, then seek to the clamped room position.
    4. Once the player is Paused, Cued or Ended within 0.5 s of that position, send `playback.ready` once.
  - During recovery the player isn't paused when it reports Playing.
  - A new room state, or a reconnect, resets the stall and recovery state.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/player/sync.test.ts`:

```ts
describe('PlaybackSync: stalls and getting ready', () => {
  const types = () => sent.map((m) => m.type)

  it('reports a stall once when the player stops moving for over 2 s', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(1_000)
    player.stall()
    vi.advanceTimersByTime(2_000)
    expect(types()).toEqual([])
    vi.advanceTimersByTime(500)
    expect(types()).toEqual(['playback.stalled'])
    vi.advanceTimersByTime(5_000)
    expect(types()).toEqual(['playback.stalled'])
  })

  it("doesn't report a stall while the room is paused", () => {
    apply(state({ position: 10 }))
    vi.advanceTimersByTime(5_000)
    expect(types()).toEqual([])
  })

  it("doesn't report a stall after a player error", () => {
    apply(state({ playing: true }))
    player.fail(150)
    player.stall()
    vi.advanceTimersByTime(5_000)
    expect(usePlayerStore.getState().error).toBe(150)
    expect(types()).toEqual([])
  })

  it("doesn't report a stall at the end of the video", () => {
    apply(state({ playing: true, position: 595 }))
    vi.advanceTimersByTime(10_000)
    expect(player.getState()).toBe(PlayerState.Ended)
    expect(types()).toEqual([])
  })

  it('after its own stall: keeps playing until the video moves, then pauses at the room position and sends ready', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(1_000)
    player.stall() // an ad starts
    vi.advanceTimersByTime(2_500)
    expect(types()).toEqual(['playback.stalled'])

    apply(state({ position: 3.25, waitingFor: 'me', autoResume: true })) // the server pauses the room for us
    vi.advanceTimersByTime(3_000)
    expect(player.getState()).toBe(PlayerState.Playing) // still in the ad, not paused
    expect(types()).toEqual(['playback.stalled'])

    player.unstall() // the ad ends and the video moves again
    vi.advanceTimersByTime(1_000)
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:3.25'])
    expect([player.getState(), player.getCurrentTime()]).toEqual([PlayerState.Paused, 3.25])
    expect(types()).toEqual(['playback.stalled', 'playback.ready'])

    apply(state({ playing: true, position: 3.25 })) // the server resumes
    expect(player.getState()).toBe(PlayerState.Playing)
  })

  it('waiting for the partner: pauses at the room position and sends nothing', () => {
    apply(state({ playing: true }))
    vi.advanceTimersByTime(3_000)
    apply(state({ position: 2.5, waitingFor: 'p2', autoResume: true }))
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:2.5'])
    vi.advanceTimersByTime(5_000)
    expect(types()).toEqual([])
  })

  it('after a reload, a snapshot waiting for me: loads, plays until the video moves, pauses at the position, sends ready', () => {
    apply(state({ position: 120, waitingFor: 'me', autoResume: true }))
    vi.advanceTimersByTime(1_000)
    expect(player.calls).toEqual([`load:${VIDEO}@120`, 'play', 'pause', 'seek:120'])
    expect(types()).toEqual(['playback.ready'])
  })

  it('recovers when the room is waiting past the end of the video', () => {
    apply(state({ position: 650, waitingFor: 'me', autoResume: true }))
    vi.advanceTimersByTime(1_000)
    expect(player.getState()).toBe(PlayerState.Ended)
    expect(types()).toEqual(['playback.ready'])
  })

  it('sends nothing while disconnected, and recovers after reconnecting', () => {
    const waiting = state({ position: 30, waitingFor: 'me', autoResume: true })
    apply(waiting)
    apply(waiting, false)
    vi.advanceTimersByTime(3_000)
    expect(types()).toEqual([])
    apply({ ...waiting }, true) // the welcome after reconnecting carries the same state
    vi.advanceTimersByTime(1_000)
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:30'])
    expect(types()).toEqual(['playback.ready'])
  })

  it('reports player errors, and clears them when a new video loads', () => {
    apply(state())
    player.fail(150)
    expect(usePlayerStore.getState().error).toBe(150)
    apply(state({ videoId: 'aaaaaaaaaaa' }))
    expect(usePlayerStore.getState().error).toBeNull()
    expect(player.calls.at(-2)).toBe('load:aaaaaaaaaaa@0')
  })

  it('blocked autoplay: flags it, and recovers once a click starts the video', () => {
    player.blockAutoplay()
    apply(state({ playing: true }))
    expect(usePlayerStore.getState().autoplayBlocked).toBe(true)
    vi.advanceTimersByTime(2_500)
    expect(types()).toEqual(['playback.stalled']) // the room waits for us

    apply(state({ position: 2.25, waitingFor: 'me', autoResume: true }))
    player.blockAutoplay(false)
    player.play() // the person clicks Start video
    expect(usePlayerStore.getState().autoplayBlocked).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(player.calls.slice(-2)).toEqual(['pause', 'seek:2.25'])
    expect(types()).toEqual(['playback.stalled', 'playback.ready'])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm --prefix web test -- src/player/sync.test.ts`
Expected: FAIL. The Task 4 tests still pass. Most of the new ones fail, for example `reports a stall once…` with `expected [] to deeply equal [ 'playback.stalled' ]`, and the recovery tests with a missing `'playback.ready'`.

- [ ] **Step 3: Replace `web/src/player/sync.ts` with the complete version**

```ts
// Keeps this browser's player in step with the room (spec section 7). It
// follows only the server's broadcast state, never a person's command, so
// both browsers act on the same thing. It also corrects drift, reports
// stalls, and gets the player ready when the room is waiting for us.
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { PlayerState, type Player, type PlayerStateValue } from './player'
import { usePlayerStore } from './store'
import { clampToDuration, DRIFT_LIMIT_S, driftTarget, expectedPosition } from './timing'

/** How often the player is sampled for progress, stalls and recovery. */
export const TICK_MS = 250
export const DRIFT_CHECK_MS = 2_000
/** No drift seeks this soon after our own load or seek. */
export const SEEK_GRACE_MS = 3_000
/** A playing room whose player hasn't moved for longer than this is stalled. */
export const STALL_MS = 2_000
/** How far a paused player may sit from the room position. */
export const PAUSED_TOLERANCE_S = 0.25
/** How close a recovering player must be to the room position to say ready. */
export const READY_TOLERANCE_S = 0.5
/** Ticks in a row the video must move before a recovering player counts as playable. */
export const PROGRESS_TICKS = 2
/** Smaller changes in the player's time don't count as moving. */
const MOVED_S = 0.05

export interface SyncInput {
  playback: PlaybackState
  you: string
  connected: boolean
}

export interface PlaybackSyncDeps {
  player: Player
  send: (msg: ClientMessage) => boolean
  serverNow: () => number
}

// When the room is auto-paused waiting for this browser: awaitingProgress
// lets the player run until the video itself moves (an ad or buffering is
// over), settling pauses and seeks to the room position, and readySent
// means playback.ready went out.
type Recovery = 'none' | 'awaitingProgress' | 'settling' | 'readySent'

export class PlaybackSync {
  private readonly player: Player
  private readonly send: (msg: ClientMessage) => boolean
  private readonly serverNow: () => number
  private readonly cleanups: Array<() => void> = []
  private input: SyncInput | null = null
  private loadedVideoId: string | null = null
  private lastSeekAt = -Infinity // local ms of our last load or seek
  private lastTime = 0 // the player's time at the last tick
  private lastProgressAt = 0 // local ms when the player's time last moved
  private progressTicks = 0
  private stalledSent = false
  private recovery: Recovery = 'none'

  constructor({ player, send, serverNow }: PlaybackSyncDeps) {
    this.player = player
    this.send = send
    this.serverNow = serverNow
    usePlayerStore.setState({ duration: 0, error: null, autoplayBlocked: false })
    player.setVolume(usePlayerStore.getState().volume)
    const tick = setInterval(() => this.tick(), TICK_MS)
    const drift = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS)
    this.cleanups.push(
      () => clearInterval(tick),
      () => clearInterval(drift),
      player.onStateChange((state) => this.playerStateChanged(state)),
      player.onError((code) => usePlayerStore.setState({ error: code })),
      player.onAutoplayBlocked(() => usePlayerStore.setState({ autoplayBlocked: true })),
      usePlayerStore.subscribe((facts, prev) => {
        if (facts.volume !== prev.volume) player.setVolume(facts.volume)
      }),
    )
  }

  /** Called on every store change. Acts only when something relevant changed. */
  update(next: SyncInput): void {
    const prev = this.input
    this.input = next
    if (!next.connected) {
      // While we're away the server pauses the partner, so stop here too.
      if (prev?.connected !== false) this.player.pause()
      return
    }
    if (!prev?.connected || prev.playback !== next.playback || prev.you !== next.you) this.apply()
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  // Makes the player match a new room state.
  private apply(): void {
    const { playback, you } = this.input!
    this.recovery = 'none'
    this.stalledSent = false
    this.progressTicks = 0
    if (playback.videoId === null) return
    const justLoaded = playback.videoId !== this.loadedVideoId
    if (justLoaded) {
      this.loadedVideoId = playback.videoId
      usePlayerStore.setState({ duration: 0, error: null, autoplayBlocked: false })
      this.cue(playback.videoId, expectedPosition(playback, this.serverNow()))
    }
    const target = this.target()
    this.markProgress()
    if (playback.waitingFor === you && playback.autoResume) {
      // Set before play(), so the Playing event that follows isn't undone.
      this.recovery = 'awaitingProgress'
      this.player.play()
    } else if (playback.playing) {
      if (!justLoaded && Math.abs(this.player.getCurrentTime() - target) > DRIFT_LIMIT_S) this.seek(target)
      // play() after the end would start the video over (spec 13).
      if (!this.expectedPastEnd()) this.player.play()
    } else {
      this.player.pause()
      if (!justLoaded && Math.abs(this.player.getCurrentTime() - target) > PAUSED_TOLERANCE_S) {
        this.moveWhilePaused(playback.videoId, target)
      }
    }
  }

  private tick(): void {
    const duration = this.player.getDuration()
    if (duration !== usePlayerStore.getState().duration) usePlayerStore.setState({ duration })
    const input = this.input
    if (!input?.connected || input.playback.videoId === null) return
    const now = Date.now()
    const time = this.player.getCurrentTime()
    const moved = Math.abs(time - this.lastTime) > MOVED_S
    this.lastTime = time
    if (moved) this.lastProgressAt = now
    if (this.recovery !== 'none') {
      this.recover(time, moved)
      return
    }
    const stalled = input.playback.playing && !this.stalledSent && now - this.lastProgressAt > STALL_MS
    // At the end of the video the player stops for good. That isn't a stall (spec 13).
    if (stalled && usePlayerStore.getState().error === null && !this.ended()) {
      this.stalledSent = this.send({ type: 'playback.stalled' })
    }
  }

  // Spec 7.3, recovery: wait until the player can play again, pause and
  // seek to the room position, then say ready.
  private recover(time: number, moved: boolean): void {
    const state = this.player.getState()
    if (this.recovery === 'awaitingProgress') {
      this.progressTicks = moved && state === PlayerState.Playing ? this.progressTicks + 1 : 0
      if (state === PlayerState.Ended) {
        this.recovery = 'settling' // the room is waiting past the end; nothing to play
      } else if (this.progressTicks >= PROGRESS_TICKS) {
        this.player.pause()
        this.seek(this.target())
        this.recovery = 'settling'
      }
      return
    }
    if (this.recovery === 'settling') {
      const still = state === PlayerState.Paused || state === PlayerState.Cued || state === PlayerState.Ended
      if (still && Math.abs(time - this.target()) <= READY_TOLERANCE_S && this.send({ type: 'playback.ready' })) {
        this.recovery = 'readySent'
      }
    }
  }

  private checkDrift(): void {
    const input = this.input
    if (!input?.connected || !input.playback.playing || input.playback.videoId === null) return
    if (usePlayerStore.getState().error !== null || Date.now() - this.lastSeekAt < SEEK_GRACE_MS) return
    // Seeking a player that is buffering, or has ended, doesn't help.
    if (this.player.getState() !== PlayerState.Playing) return
    const expected = expectedPosition(input.playback, this.serverNow())
    const target = driftTarget(this.player.getCurrentTime(), expected, this.player.getDuration())
    if (target !== null) this.seek(target)
  }

  // YouTube can start playing on its own: a seek on a cued video does, and
  // so does a click while the video is clickable. Undo that if the room
  // doesn't want playback.
  private playerStateChanged(state: PlayerStateValue): void {
    if (state === PlayerState.Playing) usePlayerStore.setState({ autoplayBlocked: false })
    const input = this.input
    if (!input || input.playback.videoId === null) return
    const wantsPlaying = input.connected && (input.playback.playing || this.recovery === 'awaitingProgress')
    if (!wantsPlaying && (state === PlayerState.Playing || state === PlayerState.Buffering)) this.player.pause()
  }

  // Seeking a video that hasn't started, or has ended, would start it
  // playing, so cue it again at the new spot instead.
  private moveWhilePaused(videoId: string, target: number): void {
    const state = this.player.getState()
    if (state === PlayerState.Paused || state === PlayerState.Playing || state === PlayerState.Buffering) {
      this.seek(target)
    } else {
      this.cue(videoId, target)
    }
  }

  private cue(videoId: string, start: number): void {
    this.player.load(videoId, start)
    this.lastSeekAt = Date.now()
  }

  private seek(seconds: number): void {
    this.player.seek(seconds)
    this.lastSeekAt = Date.now()
    this.markProgress()
  }

  // A jump we caused isn't progress, and it restarts the stall clock.
  private markProgress(): void {
    this.lastTime = this.player.getCurrentTime()
    this.lastProgressAt = Date.now()
  }

  /** Where the player should be now, within the video. */
  private target(): number {
    return clampToDuration(expectedPosition(this.input!.playback, this.serverNow()), this.player.getDuration())
  }

  private expectedPastEnd(): boolean {
    const duration = this.player.getDuration()
    return duration > 0 && expectedPosition(this.input!.playback, this.serverNow()) >= duration
  }

  private ended(): boolean {
    return this.player.getState() === PlayerState.Ended || this.expectedPastEnd()
  }
}
```

- [ ] **Step 4: Run them to see them pass, then typecheck**

Run: `npm --prefix web test -- src/player/sync.test.ts && npm --prefix web run typecheck`
Expected: PASS, `Tests  22 passed (22)` (11 from Task 4 and 11 new). The typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/sync.ts web/src/player/sync.test.ts
git commit -m "feat(web): report stalls and get ready when the room waits for this browser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The player on the stage, and playback notices

**Files:**
- Create: `web/src/app/PlayerLayer.tsx`
- Modify: `web/src/app/RoomPage.tsx`, `web/src/app/styles.css`
- Test: `web/src/app/PlayerLayer.test.tsx` (new), `web/src/app/RoomRoute.test.tsx` (add tests)

**Interfaces:**
- Consumes:
  - `PlaybackSync` (Task 5)
  - `YouTubePlayer` (Task 3)
  - `FakePlayer`, `Player` and `playerErrorMessage` (Task 2)
  - `usePlayerStore` and `initialPlayerFacts` (Task 4)
  - `getRoomClient()` from `app/session.ts`
  - `useAppStore` and `AppState` from `app/store.ts`
- Produces:
  - `type CreatePlayer = (host: HTMLElement) => Player`
  - `PlayerLayer({ createPlayer? }: { createPlayer?: CreatePlayer })`. The default is a module-level function that returns `new YouTubePlayer(host)`, so the effect doesn't run again on every render.
  - **Mounting.** It creates one player and one `PlaybackSync` per mount and feeds the sync from `useAppStore.subscribe`. The input is `{ playback: room.playback, you: room.you, connected: status.kind === 'open' }`. `send` uses `getRoomClient()?.send(msg) ?? false`, and `serverNow` uses `getRoomClient()?.serverNow() ?? Date.now()`. On unmount it destroys both.
  - **Autoplay blocked.** While autoplay is blocked it renders "Your browser blocked the video from playing." with a **Start video** button that calls `player.play()` inside the click. It also adds the class `clickable` to the player layer.
  - **`RoomPage` changes:**
    - It renders `<PlayerLayer />` first inside `<Stage>`.
    - The "No video loaded" placeholder shows only while `videoId` is null.
    - The notices are stacked in a `.notices` column: `PartnerNotice`, then the new `PlaybackNotice`.

- [ ] **Step 1: Write the failing tests**

`web/src/app/PlayerLayer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakePlayer } from '../player/fakePlayer'
import { PlayerState } from '../player/player'
import { initialPlayerFacts, usePlayerStore } from '../player/store'
import type { PlaybackState, ServerMessage } from '../protocol/schemas'
import { welcome } from '../test/fakeSocket'
import { PlayerLayer, type CreatePlayer } from './PlayerLayer'
import { applyServerMessage } from './roomState'
import { initialAppState, useAppStore } from './store'

const VIDEO = 'dQw4w9WgXcQ'
const room = applyServerMessage(null, welcome('me') as ServerMessage)!
let player: FakePlayer
let createPlayer: CreatePlayer

function setPlayback(changes: Partial<PlaybackState>) {
  act(() =>
    useAppStore.setState((s) => ({ room: { ...s.room!, playback: { ...s.room!.playback, ...changes } } })),
  )
}

beforeEach(() => {
  player = new FakePlayer()
  createPlayer = () => player
  useAppStore.setState({ roomId: 'Kx81mZq2Tq0Rb2_9sLm0Qa', status: { kind: 'open' }, room })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState)
  usePlayerStore.setState(initialPlayerFacts)
})

describe('PlayerLayer', () => {
  it("mounts the player and follows the room's playback", () => {
    render(<PlayerLayer createPlayer={createPlayer} />)
    expect(player.calls).toEqual([]) // no video yet
    setPlayback({ videoId: VIDEO, position: 42, updatedAt: Date.now() })
    expect(player.calls).toEqual([`load:${VIDEO}@42`, 'pause'])
    setPlayback({ playing: true, updatedAt: Date.now() })
    expect(player.calls.at(-1)).toBe('play')
  })

  it('destroys the player when it unmounts', () => {
    const { unmount } = render(<PlayerLayer createPlayer={createPlayer} />)
    unmount()
    expect(player.destroyed).toBe(true)
  })

  it('offers Start video when autoplay is blocked', () => {
    const { container } = render(<PlayerLayer createPlayer={createPlayer} />)
    player.blockAutoplay()
    setPlayback({ videoId: VIDEO, playing: true, updatedAt: Date.now() })
    expect(screen.getByText('Your browser blocked the video from playing.')).toBeTruthy()
    expect(container.querySelector('.player-layer.clickable')).not.toBeNull()

    player.blockAutoplay(false)
    fireEvent.click(screen.getByRole('button', { name: 'Start video' }))
    expect(player.getState()).toBe(PlayerState.Playing)
    expect(screen.queryByRole('button', { name: 'Start video' })).toBeNull()
  })
})
```

In `web/src/app/RoomRoute.test.tsx`:
- Change the testing-library import to `import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'`.
- Add these imports below the existing ones:

```tsx
import { initialPlayerFacts, usePlayerStore } from '../player/store'
import type { RoomState } from './roomState'
```

- Add `usePlayerStore.setState(initialPlayerFacts)` to the existing `afterEach`.
- Add these helpers below `function show(...)`:

```tsx
const VIDEO = 'dQw4w9WgXcQ'

function showRoom(changes: Partial<RoomState>) {
  useAppStore.setState({ roomId, status: { kind: 'open' }, room: { ...room, ...changes } })
  render(<RoomRoute roomId={roomId} />)
}

const waitingFor = (id: string) => ({ ...room.playback, videoId: VIDEO, waitingFor: id, autoResume: true })
```

- Add these tests at the end of `describe('RoomRoute', …)`:

```tsx
  it('shows the empty stage until a video is loaded', () => {
    showRoom({})
    expect(screen.getByText('No video loaded')).toBeTruthy()
    act(() => useAppStore.setState({ room: { ...room, playback: { ...room.playback, videoId: VIDEO } } }))
    expect(screen.queryByText('No video loaded')).toBeNull()
  })

  it('says who playback is waiting for', () => {
    showRoom({ participants: [...room.participants, { ...partner, connected: true }], playback: waitingFor('p2') })
    expect(screen.getByText('Waiting for Sam…')).toBeTruthy()
  })

  it('tells the person being waited for that their video is catching up', () => {
    showRoom({ playback: waitingFor('me') })
    expect(screen.getByText('Waiting for your video to catch up…')).toBeTruthy()
  })

  it('shows only the reconnecting notice while waiting for a partner who dropped', () => {
    showRoom({ participants: [...room.participants, { ...partner, connected: false }], playback: waitingFor('p2') })
    expect(screen.getByText('Sam is reconnecting…')).toBeTruthy()
    expect(screen.queryByText('Waiting for Sam…')).toBeNull()
  })

  it("says when the video can't be played here", () => {
    showRoom({ playback: { ...room.playback, videoId: VIDEO } })
    act(() => usePlayerStore.setState({ error: 150 }))
    expect(screen.getByRole('alert').textContent).toBe("This video can't be played here.")
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm --prefix web test -- src/app/PlayerLayer.test.tsx src/app/RoomRoute.test.tsx`
Expected: FAIL. `Failed to resolve import "./PlayerLayer"`. In `RoomRoute.test.tsx`, the five new tests fail with `Unable to find an element with the text: Waiting for Sam…` and similar messages, and the earlier tests still pass.

- [ ] **Step 3: Write `PlayerLayer` and update `RoomPage` and the styles**

`web/src/app/PlayerLayer.tsx`:

```tsx
// Stage layer 1: the YouTube player, kept in step with the room by
// PlaybackSync. When the browser blocks playback it offers a button, and
// lets clicks reach the video, so one click can start it.
import { useEffect, useRef } from 'react'
import type { Player } from '../player/player'
import { usePlayerStore } from '../player/store'
import { PlaybackSync } from '../player/sync'
import { YouTubePlayer } from '../player/youtubePlayer'
import { getRoomClient } from './session'
import { useAppStore, type AppState } from './store'

export type CreatePlayer = (host: HTMLElement) => Player

const createYouTubePlayer: CreatePlayer = (host) => new YouTubePlayer(host)

export function PlayerLayer({ createPlayer = createYouTubePlayer }: { createPlayer?: CreatePlayer }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<Player | null>(null)
  const hasVideo = useAppStore((s) => s.room?.playback.videoId != null)
  const blocked = usePlayerStore((s) => s.autoplayBlocked)

  useEffect(() => {
    const player = createPlayer(hostRef.current!)
    playerRef.current = player
    const sync = new PlaybackSync({
      player,
      send: (msg) => getRoomClient()?.send(msg) ?? false,
      serverNow: () => getRoomClient()?.serverNow() ?? Date.now(),
    })
    const feed = ({ room, status }: AppState) => {
      if (room) sync.update({ playback: room.playback, you: room.you, connected: status.kind === 'open' })
    }
    feed(useAppStore.getState())
    const unsubscribe = useAppStore.subscribe(feed)
    return () => {
      unsubscribe()
      sync.destroy()
      player.destroy()
      playerRef.current = null
    }
  }, [createPlayer])

  const classes = ['player-layer', hasVideo ? '' : 'empty', blocked ? 'clickable' : ''].filter(Boolean).join(' ')
  return (
    <>
      <div ref={hostRef} className={classes} />
      {blocked && (
        <div className="autoplay-prompt" role="alert">
          <p>Your browser blocked the video from playing.</p>
          {/* play() runs inside the click, so the browser sees a user gesture. */}
          <button type="button" className="primary" onClick={() => playerRef.current?.play()}>
            Start video
          </button>
        </div>
      )}
    </>
  )
}
```

`web/src/app/RoomPage.tsx`:
- Add these imports:

```tsx
import { playerErrorMessage } from '../player/player'
import { usePlayerStore } from '../player/store'
import { PlayerLayer } from './PlayerLayer'
```

- Replace the `<Stage>…</Stage>` element with:

```tsx
      <Stage>
        <PlayerLayer />
        {room.playback.videoId === null && (
          <div className="stage-empty">
            <span aria-hidden="true">🍿</span>
            <p>No video loaded</p>
          </div>
        )}
        <div className="notices">
          <PartnerNotice room={room} />
          <PlaybackNotice room={room} />
        </div>
      </Stage>
```

- Add this component below `PartnerNotice`:

```tsx
function PlaybackNotice({ room }: { room: RoomState }) {
  const error = usePlayerStore((s) => s.error)
  const { waitingFor } = room.playback
  if (error !== null) {
    return (
      <div className="notice" role="alert">
        <p>{playerErrorMessage(error)}</p>
      </div>
    )
  }
  if (waitingFor === null) return null
  if (waitingFor === room.you) {
    return (
      <div className="notice" role="status">
        <p>Waiting for your video to catch up…</p>
      </div>
    )
  }
  const partner = room.participants.find((p) => p.id === waitingFor)
  if (!partner?.connected) return null // PartnerNotice already says they're reconnecting
  return (
    <div className="notice" role="status">
      <p>Waiting for {partner.name}…</p>
    </div>
  )
}
```

`web/src/app/styles.css`:
- In the existing `.notice` rule, delete these four lines, because the new `.notices` column positions the notices:

```css
  position: absolute;
  top: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
```

- Add this after the `.notice p` rule:

```css
.notice:not(:has(button)) {
  padding: 0.6rem 1.1rem;
}

.notices {
  position: absolute;
  top: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

/* Stage layer 1. The app has its own controls, so the video ignores the
   pointer, except while autoplay is blocked and a click has to reach it. */
.player-layer {
  position: absolute;
  inset: 0;
}

.player-layer.empty {
  visibility: hidden; /* keeps the embed alive, unseen */
}

.player-layer iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  pointer-events: none;
}

.player-layer.clickable iframe {
  pointer-events: auto;
}

.autoplay-prompt {
  position: absolute;
  bottom: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.6rem 0.6rem 0.6rem 1.1rem;
  border-radius: 999px;
  background: rgba(24, 21, 28, 0.9);
  border: 1px solid var(--line);
  backdrop-filter: blur(8px);
  white-space: nowrap;
}

.autoplay-prompt p {
  margin: 0;
}
```

- [ ] **Step 4: Run the tests to see them pass, then the whole suite and the typecheck**

Run: `npm --prefix web test -- src/app/PlayerLayer.test.tsx src/app/RoomRoute.test.tsx && npm --prefix web test && npm --prefix web run typecheck`
Expected:
- PASS, with `PlayerLayer.test.tsx` 3 tests and `RoomRoute.test.tsx` 5 more than before.
- The full suite passes. A `RoomPage` in tests mounts a real `YouTubePlayer`. Its `<script>` tag stays inert, because Vitest's jsdom doesn't fetch external scripts, so the player never becomes ready.
- The typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/PlayerLayer.tsx web/src/app/PlayerLayer.test.tsx web/src/app/RoomPage.tsx web/src/app/RoomRoute.test.tsx web/src/app/styles.css
git commit -m "feat(web): put the synced player on the stage with waiting and error notices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Toolbar playback controls

**Files:**
- Create: `web/src/app/PlaybackControls.tsx`
- Modify: `web/src/app/Toolbar.tsx`, `web/src/app/styles.css`
- Test: `web/src/app/Toolbar.test.tsx` (new)

**Interfaces:**
- Consumes:
  - `parseVideoId` (Task 1)
  - `expectedPosition`, `clampToDuration` and `formatTime` (Task 1)
  - `usePlayerStore` and `setMovieVolume` (Task 4)
  - `getRoomClient()`, plus `joinRoom` and `leaveRoom` (tests only)
  - `FakeSocket` and `welcome()` (tests only)
- Produces (`PlaybackControls.tsx`):
  - **`LoadForm({ enabled })`:**
    - A `<form>` with the "YouTube link" box and **Load**.
    - On submit it runs `parseVideoId`. If that fails, it shows "That isn't a YouTube link." (`role="alert"`) and sends nothing. Otherwise it sends `playback.load` and clears the box.
    - Typing clears the error, and Load is disabled while the box is empty.
  - **`PlaybackControls({ playback, enabled })`:**
    - **Play/Pause:** labelled `Play` or `Pause`. It sends the room's expected position, clamped to the duration, or `0` for Play at the end.
    - **Seek bar:** labelled `Seek`, showing the room time. It sends one `playback.seek` on pointer up, key up or blur after a change.
    - **Time:** `m:ss / m:ss`, re-rendered every 250 ms while playing.
  - **`VolumeSlider()`:** labelled `Volume`, from 0 to 100, and calls `setMovieVolume`.
  - **`Toolbar`:** uses all three, and they're enabled only while `status.kind === 'open'`.

- [ ] **Step 1: Write the failing test**

`web/src/app/Toolbar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialPlayerFacts, usePlayerStore } from '../player/store'
import type { PlaybackState } from '../protocol/schemas'
import { FakeSocket, welcome } from '../test/fakeSocket'
import { joinRoom, leaveRoom } from './session'
import { memoryStorage } from './storage'
import { useAppStore } from './store'
import { Toolbar } from './Toolbar'

const VIDEO = 'dQw4w9WgXcQ'
const NOW = 1_800_000_000_000
let sock: FakeSocket

/** Renders the toolbar with whatever room the store holds, like RoomPage. */
function Harness() {
  const room = useAppStore((s) => s.room)
  return room ? <Toolbar room={room} /> : null
}

function playback(changes: Partial<PlaybackState>) {
  act(() =>
    sock.receive({
      type: 'playback',
      state: { videoId: VIDEO, playing: false, position: 0, updatedAt: NOW, waitingFor: null, autoResume: false, ...changes },
    }),
  )
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }) // only the clock: React and testing-library keep real timers
  vi.setSystemTime(NOW)
  usePlayerStore.setState(initialPlayerFacts)
  FakeSocket.reset()
  joinRoom(
    'Kx81mZq2Tq0Rb2_9sLm0Qa',
    { name: 'Alex', color: '#e4572e' },
    { page: { protocol: 'http:', host: 'localhost:5173' }, storage: memoryStorage(), createSocket: (url) => new FakeSocket(url) },
  )
  sock = FakeSocket.latest()
  // Answer clock pings at once, so the measured offset is exactly 0.
  sock.onSend = (msg) => {
    if (msg.type === 'ping') sock.receive({ type: 'pong', t0: msg.t0, serverTime: msg.t0 })
  }
  sock.open()
  sock.receive(welcome('me'))
  render(<Harness />)
})

afterEach(() => {
  cleanup()
  leaveRoom()
  vi.useRealTimers()
})

describe('Toolbar playback controls', () => {
  it('loads a pasted link: sends playback.load and clears the box', () => {
    const box = screen.getByRole('textbox', { name: 'YouTube link' }) as HTMLInputElement
    fireEvent.change(box, { target: { value: `https://youtu.be/${VIDEO}?si=abc` } })
    fireEvent.click(button('Load'))
    expect(sock.sentOfType('playback.load')).toEqual([{ type: 'playback.load', videoId: VIDEO }])
    expect(box.value).toBe('')
  })

  it("shows an error for a link it can't read, and sends nothing", () => {
    const box = screen.getByRole('textbox', { name: 'YouTube link' })
    fireEvent.change(box, { target: { value: 'https://vimeo.com/123456789' } })
    fireEvent.click(button('Load'))
    expect(screen.getByRole('alert').textContent).toBe("That isn't a YouTube link.")
    expect(sock.sentOfType('playback.load')).toEqual([])
    fireEvent.change(box, { target: { value: 'https://vimeo.com/12345678' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('play sends the room position; pause sends where the room is now', () => {
    playback({ position: 30 })
    fireEvent.click(button('Play'))
    expect(sock.sentOfType('playback.play')).toEqual([{ type: 'playback.play', position: 30 }])
    playback({ playing: true, position: 30, updatedAt: NOW })
    vi.setSystemTime(NOW + 5_000)
    fireEvent.click(button('Pause'))
    expect(sock.sentOfType('playback.pause')).toEqual([{ type: 'playback.pause', position: 35 }])
  })

  it('play at the end of the video starts again from the beginning', () => {
    act(() => usePlayerStore.setState({ duration: 100 }))
    playback({ playing: true, position: 95, updatedAt: NOW - 10_000 })
    fireEvent.click(button('Play'))
    expect(sock.sentOfType('playback.play')).toEqual([{ type: 'playback.play', position: 0 }])
  })

  it('the seek bar sends one seek, when released', () => {
    act(() => usePlayerStore.setState({ duration: 300 }))
    playback({ position: 10 })
    const seek = screen.getByRole('slider', { name: 'Seek' })
    fireEvent.change(seek, { target: { value: '120' } })
    fireEvent.change(seek, { target: { value: '150' } })
    expect(sock.sentOfType('playback.seek')).toEqual([])
    expect(screen.getByText('2:30 / 5:00')).toBeTruthy()
    fireEvent.pointerUp(seek)
    expect(sock.sentOfType('playback.seek')).toEqual([{ type: 'playback.seek', position: 150 }])
  })

  it("shows the room's time, ticking while playing", async () => {
    act(() => usePlayerStore.setState({ duration: 600 }))
    playback({ playing: true, position: 61, updatedAt: NOW })
    expect(screen.getByText('1:01 / 10:00')).toBeTruthy()
    vi.setSystemTime(NOW + 10_000)
    expect(await screen.findByText('1:11 / 10:00')).toBeTruthy()
  })

  it('disables playback until a video is loaded, and everything while reconnecting', () => {
    expect(button('Play').disabled).toBe(true)
    expect((screen.getByRole('slider', { name: 'Seek' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: 'YouTube link' }) as HTMLInputElement).disabled).toBe(false)
    act(() => sock.serverClose(1006))
    expect((screen.getByRole('textbox', { name: 'YouTube link' }) as HTMLInputElement).disabled).toBe(true)
    expect(button('Load').disabled).toBe(true)
  })

  it('the volume slider sets the movie volume', () => {
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '40' } })
    expect(usePlayerStore.getState().volume).toBe(40)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm --prefix web test -- src/app/Toolbar.test.tsx`
Expected: FAIL. The toolbar's controls are still disabled stubs, so most tests fail. For example, `expected [] to deeply equal [ { type: 'playback.load', … } ]`.

- [ ] **Step 3: Write the controls and wire the toolbar**

`web/src/app/PlaybackControls.tsx`:

```tsx
// The toolbar's playback controls (spec 5). They only send commands. What
// the room does comes back as a playback broadcast, for the sender too
// (spec 7.2).
import { useEffect, useReducer, useState, type FormEvent } from 'react'
import { setMovieVolume, usePlayerStore } from '../player/store'
import { clampToDuration, expectedPosition, formatTime } from '../player/timing'
import { parseVideoId } from '../player/youtubeUrl'
import type { ClientMessage, PlaybackState } from '../protocol/schemas'
import { getRoomClient } from './session'

const TIME_REFRESH_MS = 250

function send(msg: ClientMessage): boolean {
  return getRoomClient()?.send(msg) ?? false
}

function serverNow(): number {
  return getRoomClient()?.serverNow() ?? Date.now()
}

export function LoadForm({ enabled }: { enabled: boolean }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const videoId = parseVideoId(text)
    if (videoId === null) {
      setError("That isn't a YouTube link.")
      return
    }
    if (send({ type: 'playback.load', videoId })) setText('')
  }

  return (
    <form className="tool-group grow" onSubmit={submit}>
      <input
        className="url-input"
        placeholder="Paste a YouTube link"
        aria-label="YouTube link"
        aria-invalid={error !== null}
        value={text}
        disabled={!enabled}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
      />
      <button type="submit" disabled={!enabled || text.trim() === ''}>
        Load
      </button>
      {error && (
        <span className="load-error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}

/** Re-renders every 250 ms while active, so a playing room's time moves. */
function useTicker(active: boolean): void {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(tick, TIME_REFRESH_MS)
    return () => clearInterval(id)
  }, [active])
}

export function PlaybackControls({ playback, enabled }: { playback: PlaybackState; enabled: boolean }) {
  const duration = usePlayerStore((s) => s.duration)
  const [scrub, setScrub] = useState<number | null>(null) // the seek bar's value while it's being dragged
  useTicker(playback.playing)
  const hasVideo = playback.videoId !== null
  const expected = expectedPosition(playback, serverNow())
  const atEnd = duration > 0 && expected >= duration
  const playing = playback.playing && !atEnd
  const position = clampToDuration(expected, duration)

  function togglePlay() {
    const now = expectedPosition(playback, serverNow())
    const at = clampToDuration(now, duration)
    if (playing) send({ type: 'playback.pause', position: at })
    else send({ type: 'playback.play', position: duration > 0 && now >= duration ? 0 : at })
  }

  function commitSeek() {
    if (scrub === null) return
    send({ type: 'playback.seek', position: scrub })
    setScrub(null)
  }

  return (
    <div className="tool-group">
      <button type="button" aria-label={playing ? 'Pause' : 'Play'} disabled={!enabled || !hasVideo} onClick={togglePlay}>
        {playing ? '⏸' : '▶'}
      </button>
      <input
        type="range"
        className="seek"
        aria-label="Seek"
        min={0}
        max={duration}
        step={0.1}
        value={scrub ?? position}
        disabled={!enabled || !hasVideo || duration === 0}
        onChange={(e) => setScrub(Number(e.target.value))}
        onPointerUp={commitSeek}
        onKeyUp={commitSeek}
        onBlur={commitSeek}
      />
      <span className="time">{`${formatTime(scrub ?? position)} / ${formatTime(duration)}`}</span>
    </div>
  )
}

export function VolumeSlider() {
  const volume = usePlayerStore((s) => s.volume)
  return (
    <input
      type="range"
      className="volume"
      aria-label="Volume"
      min={0}
      max={100}
      value={volume}
      onChange={(e) => setMovieVolume(Number(e.target.value))}
    />
  )
}
```

`web/src/app/Toolbar.tsx`:
- Change the comment above `Toolbar` to `// Playback controls work now (plan 3). Mic, camera and the pens come in plans 4 and 5.`
- Add these imports:

```tsx
import { LoadForm, PlaybackControls, VolumeSlider } from './PlaybackControls'
import { useAppStore } from './store'
```

- Replace the start of the component, up to and including the volume `<input>`, so it reads:

```tsx
export function Toolbar({ room }: { room: RoomState }) {
  const connected = useAppStore((s) => s.status.kind === 'open')
  return (
    <footer className="toolbar">
      <LoadForm enabled={connected} />
      <PlaybackControls playback={room.playback} enabled={connected} />
      <div className="tool-group">
        <VolumeSlider />
        <button type="button" disabled>
          Mic
        </button>
```

The rest of the file (Camera, the pens, Presence and Leave) is unchanged.

`web/src/app/styles.css`: add this after the `.url-input` rule:

```css
.load-error {
  color: #ffb39c;
  font-size: 0.85rem;
  white-space: nowrap;
}
```

- [ ] **Step 4: Run it to see it pass, then the whole suite and the typecheck**

Run: `npm --prefix web test -- src/app/Toolbar.test.tsx && npm --prefix web test && npm --prefix web run typecheck`
Expected: PASS, `Tests  8 passed (8)`. The full suite passes, and the typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/PlaybackControls.tsx web/src/app/Toolbar.tsx web/src/app/Toolbar.test.tsx web/src/app/styles.css
git commit -m "feat(web): wire the toolbar's load, play, seek, time and volume controls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Playback against the real Go server

**Files:**
- Modify: `web/src/net/client.server.test.ts`

**Interfaces:**
- Consumes:
  - the existing helpers in that file: `createRoom`, `connect(roomId, name, { sockets? })`, `welcomeOf` and `waitOpts`
  - `RoomClient.send`
- Produces: two more contract tests. They're skipped unless `POPCORN_SERVER` is set, so the normal run shows `8 skipped` where it showed `6 skipped`.

- [ ] **Step 1: Write the tests**

In `web/src/net/client.server.test.ts`, add this below `const waitOpts = …`:

```ts
const VIDEO = 'dQw4w9WgXcQ'

function playbackStates(messages: ServerMessage[]) {
  return messages.flatMap((m) => (m.type === 'playback' ? [m.state] : []))
}
```

Then add these tests at the end of the `describe.skipIf(!base)(…)` block:

```ts
  it('sends both people the same playback states: load, play, a stall, then ready', async () => {
    const roomId = await createRoom()
    const a = connect(roomId, 'Alex')
    const b = connect(roomId, 'Sam')
    await vi.waitFor(() => expect([a.client.status.kind, b.client.status.kind]).toEqual(['open', 'open']), waitOpts)
    const sam = welcomeOf(b.messages).you

    // Both must have received the same n states, in the same order.
    async function bothSee(n: number) {
      await vi.waitFor(() => {
        expect(playbackStates(a.messages)).toHaveLength(n)
        expect(playbackStates(b.messages)).toHaveLength(n)
      }, waitOpts)
      expect(playbackStates(a.messages)).toEqual(playbackStates(b.messages))
      return playbackStates(a.messages)[n - 1]
    }

    expect(a.client.send({ type: 'playback.load', videoId: VIDEO })).toBe(true)
    expect(await bothSee(1)).toMatchObject({ videoId: VIDEO, playing: false, position: 0 })

    a.client.send({ type: 'playback.play', position: 12 })
    expect(await bothSee(2)).toMatchObject({ playing: true, position: 12, waitingFor: null })

    b.client.send({ type: 'playback.stalled' })
    const paused = await bothSee(3)
    expect(paused).toMatchObject({ playing: false, waitingFor: sam, autoResume: true })
    expect(paused.position).toBeGreaterThanOrEqual(12)

    b.client.send({ type: 'playback.ready' })
    expect(await bothSee(4)).toMatchObject({
      playing: true,
      position: paused.position,
      waitingFor: null,
      autoResume: false,
    })
  })

  it('after a dropped connection, the snapshot says the room waits for you, and ready resumes it', async () => {
    const roomId = await createRoom()
    const sockets: SocketLike[] = []
    const a = connect(roomId, 'Alex')
    const b = connect(roomId, 'Sam', { sockets })
    await vi.waitFor(() => expect([a.client.status.kind, b.client.status.kind]).toEqual(['open', 'open']), waitOpts)
    const sam = welcomeOf(b.messages).you
    a.client.send({ type: 'playback.load', videoId: VIDEO })
    await vi.waitFor(() => expect(playbackStates(a.messages)).toHaveLength(1), waitOpts)
    a.client.send({ type: 'playback.play', position: 0 })
    await vi.waitFor(() => expect(playbackStates(b.messages).at(-1)?.playing).toBe(true), waitOpts)

    sockets[0].close() // Sam's network drops; the client comes back with its token
    await vi.waitFor(
      () => expect(playbackStates(a.messages).at(-1)).toMatchObject({ playing: false, waitingFor: sam }),
      waitOpts,
    )
    await vi.waitFor(() => expect(b.messages.filter((m) => m.type === 'welcome')).toHaveLength(2), waitOpts)
    const rejoined = b.messages.filter((m) => m.type === 'welcome')[1]
    expect(rejoined.snapshot.playback).toMatchObject({ playing: false, waitingFor: sam, autoResume: true })

    expect(b.client.send({ type: 'playback.ready' })).toBe(true)
    await vi.waitFor(() => {
      expect(playbackStates(a.messages).at(-1)).toMatchObject({ playing: true, waitingFor: null })
      expect(playbackStates(b.messages).at(-1)).toMatchObject({ playing: true, waitingFor: null })
    }, waitOpts)
  })
```

- [ ] **Step 2: Check they're skipped without a server**

Run: `npm --prefix web test -- src/net/client.server.test.ts`
Expected: `Tests  8 skipped (8)`.

- [ ] **Step 3: Run them against the real server**

```bash
GOTOOLCHAIN=local go -C server build -o bin/popcorn ./cmd/server
PORT=8099 server/bin/popcorn &
SERVER_PID=$!
sleep 1
POPCORN_SERVER=http://localhost:8099 npm --prefix web test -- src/net/client.server.test.ts
kill $SERVER_PID
```

Expected: `Tests  8 passed (8)`. These tests can't fail red-first, because the server already implements this. They pin the contract that the client relies on. If one fails, the client's understanding of the protocol is wrong. Stop and report it. Don't change the server.

- [ ] **Step 4: Commit**

```bash
git add web/src/net/client.server.test.ts
git commit -m "test(web): check playback sync and the waiting snapshot against the real server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Record the decisions, verify everything, open the PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md` (sections 4.3, 7.3 and 13)

**Interfaces:**
- Consumes: the whole plan.
- Produces: an updated spec, a passing build and a PR against `main`.

- [ ] **Step 1: Update the spec**

In section 4.3, replace the `player/` bullet with:

```markdown
  - `player/`: the interface `Player { load(videoId, startSeconds?); play(); pause(); seek(seconds); setVolume(volume); getCurrentTime(); getDuration(); getState(); onStateChange(cb); onError(cb); onAutoplayBlocked(cb); destroy() }`. `load` cues a video without playing it. `YouTubePlayer` implements it using the IFrame API. `FakePlayer` is a test double, driven by a clock, used by unit and end-to-end tests. `PlaybackSync` drives a `Player` from the room's playback state (section 13).
```

In section 7.3, replace the **After a reconnect** bullet with:

```markdown
- **After a reconnect:** if the snapshot's `waitingFor` is the client's own ID, it loads the video and lets it play until the video itself moves (so any ad is over), then pauses, seeks to `position`, and sends `playback.ready` once the player is paused there. That's what lets a partner who dropped out auto-resume (section 9.4). The same steps follow the client's own stall.
```

In section 13, add this group after the **Client (for later plans)** list:

```markdown
**Client (plan 3)**
- **Player interface:** `load(videoId, startSeconds?)` cues without playing. Besides the calls in section 4.3, the interface has `setVolume`, `getState`, `onError`, `onAutoplayBlocked` and `destroy`. `getDuration()` is 0 until the video's metadata loads. The IFrame API is typed by hand, so there's no `@types` package.
- **Getting ready when the room waits for you:**
  - This applies after the client's own stall, and after a reconnect or reload.
  - The player plays until the video itself has moved on two ticks in a row (ticks are 250 ms apart), so an ad or buffering is over.
  - Then it pauses, seeks to `position`, and sends `playback.ready` once the player is paused within 0.5 s of it. "Ended" counts as paused, so a room waiting past the end still recovers.
  - Cueing and seeking can't avoid playing, because YouTube starts a cued video when it's seeked. The person being waited for may hear a fraction of a second of audio.
- **While the WebSocket is down:** the local player pauses, and no `stalled` or `ready` is sent. After the next `welcome`, the snapshot is applied as new.
- **Small sync rules:**
  - A paused player more than 0.25 s from the room position is seeked. One that is cued, unstarted or ended is cued again at the position instead, because seeking it would start it.
  - If YouTube starts playing while the room is paused, the client pauses it again.
  - Drift checks skip a player that isn't reporting "playing".
  - A player error stops stall reports.
- **Blocked autoplay:** when YouTube reports `onAutoplayBlocked`, the stage shows "Your browser blocked the video from playing." with **Start video**, and the video itself becomes clickable until it plays. Until then the stall rule makes the room wait for that person.
- **Controls:**
  - Play and Pause send the room's expected position, clamped to the duration. Play at or past the end sends 0.
  - The seek bar shows the room's time and sends one `playback.seek` when released.
  - The time display uses `serverNow()`, not the local player.
  - The volume slider sets this browser's YouTube volume only, and isn't saved.
- **Notices:**
  - "Waiting for {name}…" when the room is waiting for the partner, and "Waiting for your video to catch up…" when it's waiting for you. "{name} is reconnecting…" replaces the waiting notice while the partner is away.
  - YouTube errors 2, 5, 100, 101 and 150 show "This video can't be played here."
  - A failed IFrame API script shows its own message, and other error codes show the number.
- **Player facts:** the video's duration, a player error, blocked autoplay and the volume live in `player/store.ts`, apart from the room store, because they never go over the wire. Only `PlaybackSync` and the volume slider write them.
- **Known trade-off:** the server auto-pauses a stall at the expected position, about 2 seconds past where the stalled player froze, so that person skips those seconds. Fixing it would need a `position` on `playback.stalled`.
```

- [ ] **Step 2: Run every check**

```bash
npm --prefix web test
npm --prefix web run typecheck
GOTOOLCHAIN=local go -C server test -race ./...
gofmt -l server
GOTOOLCHAIN=local go -C server build -o bin/popcorn ./cmd/server && PORT=8099 server/bin/popcorn &
SERVER_PID=$!
sleep 1
POPCORN_SERVER=http://localhost:8099 npm --prefix web test
kill $SERVER_PID
npm --prefix web run embed
```

Expected:
- `npm --prefix web test`: `Tests  255 passed | 8 skipped (263)`. The baseline was 164 passed and 6 skipped. This plan adds 91 tests that run and 2 that are skipped without a server.
- The typecheck prints nothing.
- Go: `ok` for `httpapi`, `protocol`, `room` and `turn`, with no Go changes in this plan.
- `gofmt -l server` prints nothing.
- With `POPCORN_SERVER`: `Tests  263 passed (263)`.
- `embed` prints `✓ built in …` and `Copied web/dist into server/internal/webdist/dist`.

Save the summary line of each command for the PR description. If any count differs, find out why before going on, and don't adjust the expected numbers to match.

No automated test drives a real YouTube embed. The PR's manual checklist (Step 4) covers that, and the person reviewing the PR runs it.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md
git commit -m "docs: record plan 3 playback decisions in the spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Push and open the PR**

Write the PR description to a file in the scratchpad directory, then:

```bash
git push -u origin plan-3-synced-playback
gh pr create --base main --title "Plan 3: synced YouTube playback" --body-file <that file>
```

The PR description has these parts:
- a summary of what the plan builds
- the decisions, in short
- the summary line of each command from Step 2, quoted
- the manual checklist below
- it ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

Manual checklist for the PR. Use two windows in the same room, a normal one and a private one. Two tabs in one browser profile count as one person, by design.

```markdown
- [ ] Load, play, pause and seek stay in sync both ways (A→B and B→A).
- [ ] A stall (an ad, or network throttling in devtools) pauses both windows with "Waiting for {name}…" and then resumes on its own.
- [ ] Reloading one window partway through comes back at the right position after **Rejoin**.
- [ ] An unembeddable video shows "This video can't be played here".
- [ ] Safari: all of the above, and note whether **Start video** ever appears (blocked autoplay).
- [ ] Firefox: all of the above, and note whether **Start video** ever appears.
```
