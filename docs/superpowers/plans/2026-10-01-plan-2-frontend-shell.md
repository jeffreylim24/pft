# Popcorn for Two, Plan 2: Frontend Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React app in `web/` that creates a room, runs a lobby (name, color, camera and mic preview), joins over the WebSocket, and shows the room page: a letterboxed 16:9 stage with a toolbar shell. It survives dropped connections and reloads, shows clear error pages, and is built into the Go binary.

**Architecture:**
- `src/protocol/` holds zod schemas for every message, and the TypeScript types are inferred from them. A test checks them against `protocol-fixtures/`, so the Go and TypeScript sides can't drift apart.
- `src/net/RoomClient` is the only code that talks to the server. It owns one WebSocket at a time and handles the `hello`/`welcome` handshake, reconnect backoff, close codes, the clock offset and a heartbeat.
- `src/app/session.ts` connects the client to a small Zustand store. Room state in the store is changed only by the pure reducer `applyServerMessage`, which applies server messages.
- The pages read the store.
- `src/stage/` holds the pure geometry (`fitStage`, `toFraction`, `toPixels`) and the `Stage` component that uses it.

**Tech Stack:**
- Runtime: React 19.3, zod 4.6.5, Zustand 5.0.15.
- Build: Vite 8.3.2 with `@vitejs/plugin-react` 6.1.1, TypeScript 6.0.3.
- Tests: Vitest 4.1.11, jsdom 29.1.1 and `@testing-library/react` 16.3.3.
- Node 25 and npm 11, which are installed.

**Spec:** `docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md`. Sections 4.3, 5, 6, 9.1, 9.4 and **13** govern this plan. The Go code in `server/internal/protocol/` is the real contract.

## Plan series

This is plan 2 of 6. Plan 1 (Go server) has merged.

1. Go server (done)
2. **Frontend shell** (this plan)
3. Synced YouTube playback (`player/`, drift, stalls). Uses `getRoomClient().serverNow()` and `room.playback` from this plan.
4. WebRTC call and cam tiles. Uses `acquireLocalMedia()`, `room.polite`, `room.iceServers` and the `signal` messages.
5. Cursors and ink. Adds sticky `ink.points` to `applyServerMessage`, with the server's trimming rules.
6. Polish, Playwright end-to-end tests, Dockerfile and Fly.io deployment.

## Global Constraints

- **Layout and commands:**
  - The frontend lives in `web/`, next to `server/`.
  - Run every command from the repo root:
    - npm: `npm --prefix web …` (npm runs scripts inside `web/`, so test paths are relative to `web/`)
    - Go: `GOTOOLCHAIN=local go -C server …`
  - Don't change Go dependencies. The machine has Go 1.25.5, and `golang.org/x/time` stays at v0.15.0.
- **Exact dependency versions** (installed with `--save-exact`):
  - Runtime: `react` and `react-dom` 19.3.0, `zod` 4.6.5, `zustand` 5.0.15.
  - Dev: `vite` 8.3.2, `@vitejs/plugin-react` 6.1.1, `typescript` 6.0.3, `vitest` 4.1.11, `jsdom` 29.1.1, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2, `@types/react` and `@types/react-dom` 19.3.0, `@types/node` 24.19.1.
  - Nothing else: no router, no UI kit, no CSS framework.
- **Why these versions:** Vitest 5.0.3 declares Node `^22.12||^24||>=26`, and jsdom 30 does the same, so both skip Node 25. Vitest 4.1.11 and jsdom 29.1.1 declare `>=24`, so they install cleanly here. TypeScript 7 is the new native compiler, but create-vite still pins `~6.0`.
- **TypeScript:**
  - `strict` and `erasableSyntaxOnly` are on, so there are no enums or parameter properties. Use `as const` objects instead.
  - App code doesn't see Node types. Only test files do, through `tsconfig.test.json`.
- **Ownership rules:**
  - Only `src/net/` opens WebSockets.
  - Only `src/app/session.ts` writes the store.
  - Room state changes only through `applyServerMessage`.
- **Protocol:**
  - Field names and shapes match `server/internal/protocol` exactly.
  - Client schemas enforce the server's limits:
    - names are 1–32 code points after trimming
    - colors are `#rrggbb`
    - IDs and tokens are at most 64 characters
    - `videoId` matches `^[A-Za-z0-9_-]{11}$`
    - ink batches have 1–64 points
  - Server schemas check shape only.
- **Connection:**
  - Close codes:
    - Terminal, never reconnect: 1000 left, 4001 replaced, 4400 rejected, 4404 not found, 4409 room full.
    - Anything else: reconnect.
  - Backoff: 0.5 s, 1 s, 2 s, 4 s, then 8 s, with no limit on attempts. It resets after a `welcome`.
  - Clock: 5 pings sent one at a time. Keep the one with the lowest RTT, compute `offset = serverTime − (t0 + rtt/2)`, and repeat every 30 s.
  - Liveness:
    - A heartbeat ping every 10 s.
    - If nothing arrives within 5 s of a ping, reconnect.
    - If no `welcome` arrives within 10 s of opening a socket, reconnect.
- **Storage:**
  - `localStorage["popcorn.profile"]` holds `{name, color}`.
  - `sessionStorage["popcorn.resume.<roomId>"]` holds the resume token.
  - Storage access never throws. If it's blocked, an in-memory fallback is used.
- **Room IDs:** 22 base64url characters (`^[A-Za-z0-9_-]{22}$`). Routes are `/` and `/r/<roomId>`. Anything else shows "Room not found".
- **Stage:**
  - The stage is the largest 16:9 box that fits above the toolbar, centered, with whole-pixel edges.
  - Shared positions are fractions from 0 to 1.
- **Dev setup:**
  - Vite serves on `:5173` and proxies `/api` and `/ws` to `localhost:8080`.
  - `/ws` must **not** use `changeOrigin`. The Go server's same-origin check compares `Origin` with `Host`.
- **Build:** `npm --prefix web run embed` builds the app and copies `web/dist` into `server/internal/webdist/dist/`. That folder is gitignored except for `.gitkeep`.
- **Vitest workers** run with `--no-experimental-webstorage`. Node 25's built-in `localStorage` global otherwise hides jsdom's.

## Decisions made in this plan

These go beyond what the spec says. Task 12 records them in spec section 13.

1. **Heartbeat and welcome timeout** (see Global Constraints). A browser doesn't notice a half-open socket for minutes, so without these, a Wi-Fi drop could outlast the server's 30-second grace period.
2. **Back means leave, inside the app.** Going from `/r/<id>` back to the landing page within the app (Back, when the previous history entry is the app's own) sends `leave` and turns the camera off. Leaving the document any other way (closing the tab, a typed URL, Back out of the site) holds the seat for the 30-second grace period, since a reload must keep it.
3. **"Replaced" page.** When another tab takes the seat (close code 4001), this tab shows "You're in this room in another tab" with a **Use this tab instead** button. The button goes back to the lobby, where **Rejoin** takes the seat back.
4. **The camera stays on after joining.** The lobby's stream is kept for plan 4's cam tiles, and it's stopped when the person leaves the room page.
5. **Copy link.** While someone is alone in the room, the stage shows "Waiting for your partner" with a **Copy link** button.
6. **An unknown room is found on Join.** The server has no endpoint for checking whether a room exists, so a stale link shows the lobby first, then "Room not found" after Join.
7. **Toolbar controls** are rendered but disabled until the plans that make them work. **Leave** works now.
8. **Sticky ink in the store:** `welcome` and `ink.clear` only. Plan 5 adds `ink.points`, with the trimming the server does.

## Review Focus

1. **Reloading mid-movie, or duplicating the tab.** A reload must take the same seat back through **Rejoin**. A duplicated tab copies `sessionStorage`, so it takes over the seat, and the old tab must stop instead of reconnecting and fighting for it. Tested by:
   - Task 4 `stops for good on close code 4001 (replaced)`
   - Task 5 `a second tab with the same token takes over, and the first stops for good`
   - Task 9 `rejoins with the token saved by an earlier page load`
   - Task 10 `offers Rejoin after a reload in the same tab`
2. **Wi-Fi dropping silently** (a half-open socket). The client must notice within seconds and resume within the server's 30-second grace period. Tested by:
   - Task 4 `reconnects when a ping gets no answer` and `reconnects when the server goes quiet between pings`
   - Task 5 `gets the same seat back after its connection drops`
3. **The server being down or restarting when someone clicks Join.** Retries back off up to 8 seconds and never give up, and the lobby stays busy instead of flashing an empty room. Tested by:
   - Task 4 `backs off 0.5s, 1s, 2s, 4s, then 8s between failed attempts`
   - Task 11 `keeps the lobby busy until the first welcome, even while retrying`
4. **A blocked or missing camera.** The person can still join, and their initial shows instead. Tested by:
   - Task 7 `reports blocked when permission is denied, without asking twice` and `falls back to the mic alone when there is no camera`
   - Task 10 `shows the initial and still allows joining without a camera`
5. **Names at the edge of the server's rules** (emoji, surrounding spaces, 33 characters). The client must count the way Go does, in code points after trimming, or the server answers `bad_message` and closes with 4400. Tested by:
   - Task 1 `accepts 32-emoji name` and `rejects 33-character name`
   - Task 7 `needs 1 to 32 characters after trimming`

---

## File Structure

```
web/
  package.json               exact versions; scripts: dev, build, embed, test, typecheck
  package-lock.json
  .gitignore                 node_modules/, dist/
  index.html                 root div, popcorn favicon, /src/main.tsx
  vite.config.ts             React plugin, dev proxy, Vitest settings
  tsconfig.json              references app, test and node configs
  tsconfig.app.json          src/ without tests; DOM types only
  tsconfig.test.json         src/ with tests; adds Node types
  tsconfig.node.json         vite.config.ts and scripts/
  scripts/embed.mjs          copies dist/ into server/internal/webdist/dist/
  src/
    main.tsx                 createRoot + StrictMode
    protocol/
      schemas.ts             zod schemas, inferred types, CloseCode, ErrorCode, limits
      fixtures.test.ts       every fixture ↔ every schema
      schemas.test.ts        client-side validation matches the Go rules
    net/
      client.ts              RoomClient: handshake, backoff, close codes, clock, heartbeat
      backoff.ts             backoffDelay(n)
      clock.ts               sampleFromPong, bestOffset
      ids.ts                 randomId()
      url.ts                 roomSocketUrl(page, roomId)
      helpers.test.ts
      client.test.ts         fake socket + fake timers
      client.server.test.ts  against the real Go server (needs POPCORN_SERVER)
    stage/
      geometry.ts            fitStage, toFraction, toPixels, clampUnit
      geometry.test.ts
      Stage.tsx              letterboxed 16:9 stage that follows its container's size
    app/
      store.ts               Zustand store: roomId, status, room
      roomState.ts           RoomState, applyServerMessage
      session.ts             joinRoom, leaveRoom, resetSession, getRoomClient, syncSessionWithRoute
      storage.ts             browserStorage, memoryStorage
      prefs.ts               PALETTE, Profile, loadProfile, saveProfile, isValidName
      media.ts               acquireLocalMedia, releaseLocalMedia, useLocalMedia
      routes.ts              parseRoute, roomPath, navigate, useRoute, ROOM_ID
      api.ts                 createRoom()
      App.tsx                route → page
      Landing.tsx            hero + CreateRoomButton
      Lobby.tsx              name, color, preview, tip, Join/Rejoin
      MediaViews.tsx         VideoView, InitialTile, MicMeter
      RoomRoute.tsx          lobby / room / error page for /r/<id>
      RoomPage.tsx           stage, partner notice, reconnecting banner, toolbar
      Toolbar.tsx            the toolbar shell, presence and Leave
      ErrorPage.tsx          room full, not found, replaced, rejected
      styles.css
      *.test.ts(x)
    test/
      fakeSocket.ts          FakeSocket and a welcome() builder, used by tests only
```

---

### Task 1: Vite project and protocol schemas checked against the fixtures

**Files:**
- Create: `web/package.json`, `web/package-lock.json` (by npm), `web/.gitignore`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/tsconfig.app.json`, `web/tsconfig.test.json`, `web/tsconfig.node.json`
- Create: `web/src/protocol/schemas.ts`
- Test: `web/src/protocol/fixtures.test.ts`, `web/src/protocol/schemas.test.ts`

**Interfaces:**
- Consumes: `protocol-fixtures/client/*.json` (18 files) and `protocol-fixtures/server/*.json` (14 files) from plan 1.
- Produces (`web/src/protocol/schemas.ts`):
  - **Union schemas:** `clientMessage` and `serverMessage`, both zod discriminated unions on `type`.
  - **Type lists:** `clientTypes: string[]` and `serverTypes: string[]`.
  - **Shared schemas:** `rect`, `point`, `inkMode`, `participant`, `snapshotParticipant`, `playbackState`, `camState`, `stroke`, `snapshot`, `iceServer`.
  - **Types:** `ClientMessage`, `ServerMessage`, `ServerMessageOf<T>`, `Rect`, `Point` (`[x, y]`), `InkMode`, `Participant`, `SnapshotParticipant`, `PlaybackState`, `CamState`, `Stroke`, `Snapshot`, `IceServer`.
  - **Constants:**
    - `CloseCode` `{Normal: 1000, Replaced: 4001, BadMessage: 4400, NotFound: 4404, RoomFull: 4409}`
    - `ErrorCode`
    - `MAX_NAME_CHARS = 32`, `MAX_ID_LENGTH = 64`, `MAX_INK_BATCH = 64`
  - **Function:** `nameLength(name): number`, which trims and then counts code points.

- [ ] **Step 1: Create the package and install exact versions**

`web/package.json`. Write only the scripts; npm adds the dependencies.

```json
{
  "name": "popcorn-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "embed": "npm run build && node scripts/embed.mjs",
    "test": "vitest run",
    "typecheck": "tsc -b"
  }
}
```

```bash
npm --prefix web install --save-exact react@19.3.0 react-dom@19.3.0 zod@4.6.5 zustand@5.0.15
npm --prefix web install --save-exact --save-dev vite@8.3.2 @vitejs/plugin-react@6.1.1 typescript@6.0.3 vitest@4.1.11 jsdom@29.1.1 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @types/react@19.3.0 @types/react-dom@19.3.0 @types/node@24.19.1
```

Expected: both commands end with `found 0 vulnerabilities`, and there are **no** `EBADENGINE` warnings. `web/package.json` now matches:

```json
{
  "name": "popcorn-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "embed": "npm run build && node scripts/embed.mjs",
    "test": "vitest run",
    "typecheck": "tsc -b"
  },
  "dependencies": {
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "zod": "4.6.5",
    "zustand": "5.0.15"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.2",
    "@testing-library/react": "16.3.3",
    "@types/node": "24.19.1",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "jsdom": "29.1.1",
    "typescript": "6.0.3",
    "vite": "8.3.2",
    "vitest": "4.1.11"
  }
}
```

- [ ] **Step 2: Write the config files**

`web/.gitignore`:

```gitignore
node_modules/
dist/
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍿</text></svg>" />
    <title>Popcorn for Two</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const goServer = 'localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://${goServer}`,
      // No changeOrigin here: the Go server accepts a WebSocket only when its
      // Origin matches its Host, so Host must stay the one the browser sent.
      '/ws': { target: `ws://${goServer}`, ws: true },
    },
  },
  test: {
    environment: 'node',
    // Node 25 has its own localStorage global, which hides jsdom's.
    execArgv: ['--no-experimental-webstorage'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

`web/tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

`web/tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "types": ["vite/client"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test"]
}
```

`web/tsconfig.test.json` (the same compiler options, plus Node types and the test files):

```json
{
  "extends": "./tsconfig.app.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.test.tsbuildinfo",
    "types": ["vite/client", "node"]
  },
  "include": ["src"],
  "exclude": []
}
```

`web/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023"],
    "types": ["node"],
    "skipLibCheck": true,
    "module": "nodenext",
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts", "scripts"]
}
```

- [ ] **Step 3: Write the failing tests**

`web/src/protocol/fixtures.test.ts`. This is the TypeScript half of spec section 6.4. `toStrictEqual(raw)` after parsing catches a field Go sends that the schema doesn't know about, because zod drops unknown keys. The second test catches a fixture with no schema, and a schema with no fixture.

```ts
// The TypeScript half of the protocol contract (spec section 6.4). The Go
// tests round-trip the same files through the Go structs.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clientMessage, clientTypes, serverMessage, serverTypes } from './schemas'

const fixturesDir = fileURLToPath(new URL('../../../protocol-fixtures', import.meta.url))

const suites = [
  { dir: 'client', schema: clientMessage, types: clientTypes },
  { dir: 'server', schema: serverMessage, types: serverTypes },
]

for (const { dir, schema, types } of suites) {
  describe(`${dir} fixtures`, () => {
    const files = readdirSync(join(fixturesDir, dir)).filter((f) => f.endsWith('.json'))

    it.each(files)('%s parses without losing a field', (file) => {
      const raw: unknown = JSON.parse(readFileSync(join(fixturesDir, dir, file), 'utf8'))
      const parsed = schema.parse(raw)
      expect(parsed.type).toBe(file.replace(/\.json$/, ''))
      // zod drops keys it doesn't know, so equality means the schema knows
      // every field the Go side sends.
      expect(parsed).toStrictEqual(raw)
    })

    it('has exactly one fixture per message type', () => {
      const fixtureTypes = files.map((f) => f.replace(/\.json$/, '')).sort()
      expect(fixtureTypes).toEqual([...types].sort())
    })
  })
}
```

`web/src/protocol/schemas.test.ts`. These mirror the Go rules in `server/internal/protocol/validate_test.go`.

```ts
import { describe, expect, it } from 'vitest'
import { clientMessage } from './schemas'

const hello = { type: 'hello', name: 'Alex', color: '#e4572e', pageSession: 'ps-1' }
const pts = (n: number) => Array.from({ length: n }, () => [0.1, 0.1])
const ink = { type: 'ink.points', strokeId: 's', mode: 'fading', color: '#000000', width: 0.004 }

// The same rules as server/internal/protocol/validate_test.go, so the client
// catches its own mistakes instead of getting bad_message back.
describe('client messages the server would reject', () => {
  it.each([
    ['blank name', { ...hello, name: '   ' }],
    ['33-character name', { ...hello, name: 'a'.repeat(33) }],
    ['named color', { ...hello, color: 'red' }],
    ['missing pageSession', { type: 'hello', name: 'A', color: '#112233' }],
    ['65-character resume token', { ...hello, resumeToken: 't'.repeat(65) }],
    ['short video id', { type: 'playback.load', videoId: 'short' }],
    ['video id with a slash', { type: 'playback.load', videoId: 'abc/defghij' }],
    ['position as a string', { type: 'playback.play', position: 'ten' }],
    ['empty cam id', { type: 'cam.grab', camId: '' }],
    ['cam.move without rect', { type: 'cam.move', camId: 'c' }],
    ['unknown ink mode', { ...ink, mode: 'glitter', points: pts(1) }],
    ['empty ink batch', { ...ink, points: [] }],
    ['65-point ink batch', { ...ink, points: pts(65) }],
    ['signal without data', { type: 'signal' }],
    ['unknown type', { type: 'dance' }],
  ])('rejects %s', (_, msg) => {
    expect(clientMessage.safeParse(msg).success).toBe(false)
  })
})

describe('client messages at the limits', () => {
  it.each([
    // 32 emoji are 64 UTF-16 units but 32 code points, and Go counts runes.
    ['32-emoji name', { ...hello, name: '🍿'.repeat(32) }],
    ['name with surrounding spaces', { ...hello, name: '  Alex  ' }],
    ['64-point ink batch', { ...ink, points: pts(64) }],
  ])('accepts %s', (_, msg) => {
    expect(clientMessage.safeParse(msg).success).toBe(true)
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npm --prefix web test`
Expected: FAIL, with `Error: Cannot find module './schemas' imported from …/web/src/protocol/fixtures.test.ts` (and the same for `schemas.test.ts`).

- [ ] **Step 5: Write the schemas**

`web/src/protocol/schemas.ts`:

```ts
// The JSON messages exchanged with the server over the WebSocket. These
// mirror server/internal/protocol by hand; the files in protocol-fixtures/
// keep the two sides in sync (see fixtures.test.ts).
//
// Client schemas enforce the server's validation rules, so the client never
// sends something the server would reject. Server schemas only check shape,
// so a stricter rule on our side can't make us drop a real message.
import { z } from 'zod'

// Limits from server/internal/protocol/validate.go.
export const MAX_NAME_CHARS = 32
export const MAX_ID_LENGTH = 64
export const MAX_INK_BATCH = 64

// WebSocket close codes the server uses.
export const CloseCode = {
  Normal: 1000, // the participant left on purpose
  Replaced: 4001, // the same participant connected again elsewhere
  BadMessage: 4400, // the first message wasn't a valid hello
  NotFound: 4404,
  RoomFull: 4409,
} as const

// Codes sent in error messages.
export const ErrorCode = {
  BadMessage: 'bad_message',
  RateLimited: 'rate_limited',
  RoomFull: 'room_full',
  NotFound: 'not_found',
} as const

/** Names are counted in code points, like Go counts runes. */
export function nameLength(name: string): number {
  return [...name.trim()].length
}

const id = z.string().min(1).max(MAX_ID_LENGTH)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/)
const name = z.string().refine((s) => {
  const n = nameLength(s)
  return n >= 1 && n <= MAX_NAME_CHARS
}, `must be 1-${MAX_NAME_CHARS} characters`)
// A WebRTC description or ICE candidate; the server passes it through unread.
const signalData = z.record(z.string(), z.unknown())

// ---- Shared shapes ----

export const rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
export const point = z.tuple([z.number(), z.number()])
export const inkMode = z.enum(['fading', 'sticky'])
export const participant = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  pageSession: z.string(),
})
export const snapshotParticipant = participant.extend({ connected: z.boolean() })
export const playbackState = z.object({
  videoId: z.string().nullable(),
  playing: z.boolean(),
  position: z.number(), // seconds, as of updatedAt
  updatedAt: z.number(), // server Unix milliseconds
  waitingFor: z.string().nullable(),
  autoResume: z.boolean(),
})
export const camState = z.object({ rect, holder: z.string().nullable() })
export const stroke = z.object({
  id: z.string(),
  author: z.string(),
  color: z.string(),
  width: z.number(),
  points: z.array(point),
})
export const snapshot = z.object({
  participants: z.array(snapshotParticipant),
  playback: playbackState,
  cams: z.record(z.string(), camState),
  stickyStrokes: z.array(stroke),
})
export const iceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
})

// ---- Client → server ----

export const clientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    name,
    color,
    pageSession: id,
    resumeToken: z.string().max(MAX_ID_LENGTH).optional(),
  }),
  z.object({ type: z.literal('ping'), t0: z.number() }),
  z.object({ type: z.literal('playback.load'), videoId }),
  z.object({ type: z.literal('playback.play'), position: z.number() }),
  z.object({ type: z.literal('playback.pause'), position: z.number() }),
  z.object({ type: z.literal('playback.seek'), position: z.number() }),
  z.object({ type: z.literal('playback.stalled') }),
  z.object({ type: z.literal('playback.ready') }),
  z.object({ type: z.literal('cam.grab'), camId: id }),
  z.object({ type: z.literal('cam.move'), camId: id, rect }),
  z.object({ type: z.literal('cam.release'), camId: id, rect }),
  z.object({ type: z.literal('cursor'), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('cursor.hide') }),
  z.object({
    type: z.literal('ink.points'),
    strokeId: id,
    mode: inkMode,
    color,
    width: z.number(),
    points: z.array(point).min(1).max(MAX_INK_BATCH),
  }),
  z.object({ type: z.literal('ink.end'), strokeId: id }),
  z.object({ type: z.literal('ink.clear') }),
  z.object({ type: z.literal('signal'), data: signalData }),
  z.object({ type: z.literal('leave') }),
])

// ---- Server → client ----

export const serverMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    you: z.string(),
    resumeToken: z.string(),
    polite: z.boolean(),
    iceServers: z.array(iceServer),
    snapshot,
  }),
  z.object({ type: z.literal('pong'), t0: z.number(), serverTime: z.number() }),
  z.object({ type: z.literal('participant.joined'), participant }),
  z.object({ type: z.literal('participant.reconnecting'), id: z.string() }),
  z.object({ type: z.literal('participant.left'), id: z.string() }),
  z.object({ type: z.literal('playback'), state: playbackState }),
  z.object({ type: z.literal('cam'), camId: z.string(), rect, holder: z.string().nullable() }),
  z.object({ type: z.literal('cursor'), from: z.string(), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('cursor.hide'), from: z.string() }),
  z.object({
    type: z.literal('ink.points'),
    from: z.string(),
    strokeId: z.string(),
    mode: inkMode,
    color: z.string(),
    width: z.number(),
    points: z.array(point),
  }),
  z.object({ type: z.literal('ink.end'), from: z.string(), strokeId: z.string() }),
  z.object({ type: z.literal('ink.clear'), from: z.string() }),
  z.object({ type: z.literal('signal'), from: z.string(), data: signalData }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])

/** Every message type, like Go's ClientTypes() and ServerTypes(). */
export const clientTypes: string[] = clientMessage.options.map((o) => o.shape.type.value)
export const serverTypes: string[] = serverMessage.options.map((o) => o.shape.type.value)

export type ClientMessage = z.infer<typeof clientMessage>
export type ServerMessage = z.infer<typeof serverMessage>
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>
export type Rect = z.infer<typeof rect>
export type Point = z.infer<typeof point>
export type InkMode = z.infer<typeof inkMode>
export type Participant = z.infer<typeof participant>
export type SnapshotParticipant = z.infer<typeof snapshotParticipant>
export type PlaybackState = z.infer<typeof playbackState>
export type CamState = z.infer<typeof camState>
export type Stroke = z.infer<typeof stroke>
export type Snapshot = z.infer<typeof snapshot>
export type IceServer = z.infer<typeof iceServer>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix web test`
Expected: `Test Files  2 passed (2)` and `Tests  52 passed (52)`.

- [ ] **Step 7: Prove the drift check works**

```bash
echo '{"type":"dance"}' > protocol-fixtures/server/dance.json
npm --prefix web test -- src/protocol/fixtures.test.ts
rm protocol-fixtures/server/dance.json
```

Expected: 2 failures, `dance.json parses without losing a field` and `has exactly one fixture per message type`. After the `rm`, rerun and all 34 fixture tests pass.

- [ ] **Step 8: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no output, exit code 0.

- [ ] **Step 9: Commit**

```bash
git add web/package.json web/package-lock.json web/.gitignore web/index.html web/vite.config.ts web/tsconfig*.json web/src/protocol
git commit -m "feat(web): Vite + React scaffold and zod protocol schemas checked against fixtures"
```

---

### Task 2: Stage geometry

**Files:**
- Create: `web/src/stage/geometry.ts`
- Test: `web/src/stage/geometry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`web/src/stage/geometry.ts`):
  - `STAGE_ASPECT = 16 / 9`
  - `interface Box { left; top; width; height }` (pixels)
  - `interface Pos { x; y }`
  - `fitStage(areaWidth, areaHeight): Box`
  - `toFraction(p: Pos, stage: Box): Pos`, not clamped
  - `toPixels(f: Pos, stage: Box): Pos`
  - `clampUnit(v): number`

- [ ] **Step 1: Write the failing test**

`web/src/stage/geometry.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix web test -- src/stage/geometry.test.ts`
Expected: FAIL with `Error: Cannot find module './geometry'`.

- [ ] **Step 3: Write the geometry helpers**

`web/src/stage/geometry.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix web test -- src/stage/geometry.test.ts`
Expected: `Tests  11 passed (11)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/stage
git commit -m "feat(web): stage geometry: largest 16:9 fit, fractions and pixels"
```

---

### Task 3: Network helpers (backoff, clock math, IDs, socket URL)

**Files:**
- Create: `web/src/net/backoff.ts`, `web/src/net/clock.ts`, `web/src/net/ids.ts`, `web/src/net/url.ts`
- Test: `web/src/net/helpers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `backoffDelay(n: number): number` (ms). n is 0-based: 500, 1000, 2000, 4000, 8000, 8000, …
  - `interface ClockSample { rtt; offset }`
  - `sampleFromPong(t0, t1, serverTime): ClockSample`
  - `bestOffset(samples): number | null`
  - `randomId(bytes = 12): string`, 16 URL-safe characters by default. It uses `crypto.getRandomValues`, which works on plain-http LAN addresses, unlike `randomUUID`.
  - `roomSocketUrl(page: {protocol, host}, roomId): string`, which returns `ws://` or `wss://` plus `host/ws?room=<id>`.

- [ ] **Step 1: Write the failing test**

`web/src/net/helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { backoffDelay } from './backoff'
import { bestOffset, sampleFromPong } from './clock'
import { randomId } from './ids'
import { roomSocketUrl } from './url'

describe('backoffDelay', () => {
  it('doubles from 0.5s and caps at 8s', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000])
  })
})

describe('clock offset', () => {
  it('assumes the reply took half the round trip', () => {
    // Sent at 1000, answered at 1100: the server stamped it at about 1050
    // local time, and it said 6050, so the server is 5000ms ahead.
    expect(sampleFromPong(1000, 1100, 6050)).toEqual({ rtt: 100, offset: 5000 })
  })

  it('handles a server clock that is behind', () => {
    expect(sampleFromPong(1000, 1020, 10)).toEqual({ rtt: 20, offset: -1000 })
  })

  it('keeps the sample with the shortest round trip', () => {
    const samples = [
      { rtt: 120, offset: 5040 },
      { rtt: 20, offset: 5001 },
      { rtt: 300, offset: 4900 },
      { rtt: 20, offset: 5003 },
    ]
    expect(bestOffset(samples)).toBe(5001)
  })

  it('has no offset without samples', () => {
    expect(bestOffset([])).toBeNull()
  })
})

describe('randomId', () => {
  it('is URL-safe, 16 characters, and different each time', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()))
    expect(ids.size).toBe(100)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })
})

describe('roomSocketUrl', () => {
  it('uses ws on http and wss on https, on the page host', () => {
    expect(roomSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, 'abc')).toBe('ws://localhost:5173/ws?room=abc')
    expect(roomSocketUrl({ protocol: 'https:', host: 'popcorn.fly.dev' }, 'abc')).toBe('wss://popcorn.fly.dev/ws?room=abc')
  })

  it('escapes the room ID', () => {
    expect(roomSocketUrl({ protocol: 'http:', host: 'h' }, 'a&b')).toBe('ws://h/ws?room=a%26b')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix web test -- src/net/helpers.test.ts`
Expected: FAIL with `Error: Cannot find module './backoff'`.

- [ ] **Step 3: Write the helpers**

`web/src/net/backoff.ts`:

```ts
const FIRST_DELAY_MS = 500
const MAX_DELAY_MS = 8000

/** How long to wait before reconnect attempt n (0-based): 0.5s, 1s, 2s, 4s, then 8s. */
export function backoffDelay(n: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** n, MAX_DELAY_MS)
}
```

`web/src/net/clock.ts`:

```ts
// Clock offset between this browser and the server (spec section 7.3).
// Server time is then Date.now() + offset.

export interface ClockSample {
  rtt: number
  offset: number
}

/** One ping/pong exchange: sent at t0, answered at t1, both local ms. */
export function sampleFromPong(t0: number, t1: number, serverTime: number): ClockSample {
  const rtt = t1 - t0
  return { rtt, offset: serverTime - (t0 + rtt / 2) }
}

/**
 * The offset from the sample with the shortest round trip: it had the least
 * room for network delay to be lopsided. Null if there are no samples.
 */
export function bestOffset(samples: readonly ClockSample[]): number | null {
  let best: ClockSample | null = null
  for (const s of samples) {
    if (best === null || s.rtt < best.rtt) best = s
  }
  return best === null ? null : best.offset
}
```

`web/src/net/ids.ts`:

```ts
/**
 * A random URL-safe ID (16 characters by default). Uses getRandomValues, not
 * randomUUID, because randomUUID is missing on plain-http LAN addresses.
 */
export function randomId(bytes = 12): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
```

`web/src/net/url.ts`:

```ts
/** The WebSocket URL for a room, on the same host as the page. */
export function roomSocketUrl(page: { protocol: string; host: string }, roomId: string): string {
  const scheme = page.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${page.host}/ws?room=${encodeURIComponent(roomId)}`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix web test -- src/net/helpers.test.ts`
Expected: `Tests  8 passed (8)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/net
git commit -m "feat(web): reconnect backoff, clock offset math, random IDs and socket URL"
```

---

### Task 4: RoomClient

**Files:**
- Create: `web/src/net/client.ts`
- Create: `web/src/test/fakeSocket.ts` (a test helper; excluded from the app build by `tsconfig.app.json`)
- Test: `web/src/net/client.test.ts`

**Interfaces:**
- Consumes: `clientMessage`, `serverMessage`, `CloseCode`, `ClientMessage`, `ServerMessage`, `ServerMessageOf` (Task 1); `backoffDelay`, `sampleFromPong`, `bestOffset`, `ClockSample` (Task 3).
- Produces (`web/src/net/client.ts`):
  - **Constants:** `CLOCK_SAMPLES = 5`, `CLOCK_INTERVAL_MS = 30_000`, `HEARTBEAT_MS = 10_000`, `PONG_TIMEOUT_MS = 5_000`, `WELCOME_TIMEOUT_MS = 10_000`.
  - **Types:**
    - `CloseReason = 'left' | 'replaced' | 'room_full' | 'not_found' | 'rejected'`
    - `ConnectionStatus = {kind:'connecting'} | {kind:'open'} | {kind:'reconnecting'; attempt: number} | {kind:'closed'; reason: CloseReason}`
  - **Interfaces:**
    - `SocketLike { onopen; onmessage; onclose; send(data: string); close() }`. The browser `WebSocket` satisfies it.
    - `RoomClientOptions { url; hello: {name, color, pageSession}; resumeToken?: string | null; onResumeToken?(token); createSocket?(url) }`
  - **`class RoomClient`:**
    - `constructor(opts)`
    - `connect()`
    - `send(msg: ClientMessage): boolean`. It returns false unless the client is open, or if the message fails `clientMessage`.
    - `leave()`
    - `subscribe(listener): unsubscribe`
    - `onStatus(listener): unsubscribe`
    - `get status`
    - `get clockOffsetMs: number | null`, which is null until the first round of pings finishes
    - `serverNow(): number`
  - **Test helpers (`web/src/test/fakeSocket.ts`):** `class FakeSocket` with static `all`, `latest()` and `reset()`; instance `sent`, `closed`, `onSend`, `open()`, `receive(msg)`, `serverClose(code)` and `sentOfType(type)`. Also `welcome(you = 'me', resumeToken = 'token-1')`, which builds a valid welcome message.

How the client behaves (the tests pin each point):
- **Handshake:**
  - `hello` goes out in `onopen`, with `resumeToken` only if the client has one.
  - The status becomes `open` when `welcome` arrives. The client stores the welcome's token, calls `onResumeToken`, starts a clock round and starts the 10-second heartbeat.
- **Incoming messages:**
  - Each one is parsed with `serverMessage`. Invalid ones are logged and dropped.
  - Any valid message clears the reply deadline.
  - The client handles `welcome` and `pong` itself first, then passes every valid message to subscribers, so a buggy subscriber can't break the connection logic.
- **Closing:**
  - A close with code 1000, 4001, 4400, 4404 or 4409 is final.
  - Any other close, or a missed deadline, drops the socket and retries after `backoffDelay(attempt − 1)`.
  - `dropSocket` detaches the socket's handlers **before** closing it, so a late event from an old socket can't change anything.
- **Pings:** the reply deadline and the clock-ping `t0` are set **before** the ping is sent. A reply that arrives instantly (as in tests) still finds them.

- [ ] **Step 1: Write the fake socket**

`web/src/test/fakeSocket.ts`:

```ts
// A stand-in for the browser WebSocket, driven by the test.
import type { SocketLike } from '../net/client'

export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = []

  static latest(): FakeSocket {
    const s = FakeSocket.all.at(-1)
    if (!s) throw new Error('no socket was created')
    return s
  }

  static reset(): void {
    FakeSocket.all = []
  }

  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  closed = false
  /** Called after every send; lets a test answer pings automatically. */
  onSend: ((msg: Record<string, unknown>) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>
    this.sent.push(msg)
    this.onSend?.(msg)
  }

  close(): void {
    this.closed = true
  }

  // ---- driven by the test ----

  open(): void {
    this.onopen?.({} as Event)
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) } as MessageEvent)
  }

  serverClose(code: number): void {
    this.onclose?.({ code } as CloseEvent)
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type)
  }
}

export function welcome(you = 'me', resumeToken = 'token-1') {
  return {
    type: 'welcome',
    you,
    resumeToken,
    polite: false,
    iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    snapshot: {
      participants: [{ id: you, name: 'Alex', color: '#e4572e', pageSession: 'ps-1', connected: true }],
      playback: { videoId: null, playing: false, position: 0, updatedAt: 0, waitingFor: null, autoResume: false },
      cams: { [you]: { rect: { x: 0.02, y: 0.745, w: 0.22, h: 0.22 }, holder: null } },
      stickyStrokes: [],
    },
  }
}
```

- [ ] **Step 2: Write the failing test**

`web/src/net/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, welcome } from '../test/fakeSocket'
import { CLOCK_INTERVAL_MS, HEARTBEAT_MS, PONG_TIMEOUT_MS, RoomClient, WELCOME_TIMEOUT_MS, type RoomClientOptions } from './client'

const hello = { name: 'Alex', color: '#e4572e', pageSession: 'ps-1' }

function makeClient(extra: Partial<RoomClientOptions> = {}) {
  const client = new RoomClient({
    url: 'ws://test/ws?room=r1',
    hello,
    createSocket: (url) => new FakeSocket(url),
    ...extra,
  })
  client.connect()
  return client
}

/** Connects and gets welcomed; returns the socket. */
function join(client: RoomClient, token = 'token-1') {
  const sock = FakeSocket.latest()
  sock.open()
  sock.receive(welcome('me', token))
  expect(client.status).toEqual({ kind: 'open' })
  return sock
}

/** Answers every ping as a server whose clock is `offset` ms ahead, instantly. */
function autoPong(sock: FakeSocket, offset = 0) {
  sock.onSend = (msg) => {
    if (msg.type === 'ping') sock.receive({ type: 'pong', t0: msg.t0, serverTime: Date.now() + offset })
  }
}

beforeEach(() => {
  FakeSocket.reset()
  vi.useFakeTimers()
  vi.setSystemTime(1_790_000_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('handshake', () => {
  it('sends hello when the socket opens and is open after welcome', () => {
    const client = makeClient()
    const statuses: string[] = []
    client.onStatus((s) => statuses.push(s.kind))
    const sock = FakeSocket.latest()
    expect(sock.url).toBe('ws://test/ws?room=r1')
    expect(client.status).toEqual({ kind: 'connecting' })

    sock.open()
    expect(sock.sent[0]).toEqual({ type: 'hello', ...hello })

    sock.receive(welcome())
    expect(statuses).toEqual(['open'])
  })

  it('includes a stored resume token in hello', () => {
    makeClient({ resumeToken: 'saved-token' })
    const sock = FakeSocket.latest()
    sock.open()
    expect(sock.sent[0]).toEqual({ type: 'hello', ...hello, resumeToken: 'saved-token' })
  })

  it('hands every welcome token to onResumeToken', () => {
    const tokens: string[] = []
    const client = makeClient({ onResumeToken: (t) => tokens.push(t) })
    join(client, 'token-A')
    expect(tokens).toEqual(['token-A'])
  })

  it('passes valid server messages to subscribers and drops invalid ones', () => {
    const client = makeClient()
    const got: string[] = []
    client.subscribe((m) => got.push(m.type))
    const sock = join(client)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    sock.receive({ type: 'cursor', from: 'p2', x: 0.5, y: 0.5 })
    sock.receive({ type: 'cursor', from: 'p2', x: 'left' }) // wrong field type
    sock.receive({ type: 'dance' }) // unknown type
    sock.receive('not json {')
    expect(got).toEqual(['welcome', 'cursor'])
  })
})

describe('sending', () => {
  it('refuses to send before welcome', () => {
    const client = makeClient()
    FakeSocket.latest().open()
    expect(client.send({ type: 'cursor', x: 0.5, y: 0.5 })).toBe(false)
  })

  it('sends valid messages once open', () => {
    const client = makeClient()
    const sock = join(client)
    expect(client.send({ type: 'cursor', x: 0.5, y: 0.5 })).toBe(true)
    expect(sock.sentOfType('cursor')).toEqual([{ type: 'cursor', x: 0.5, y: 0.5 }])
  })

  it('refuses a message the server would reject', () => {
    const client = makeClient()
    const sock = join(client)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(client.send({ type: 'playback.load', videoId: 'nope' })).toBe(false)
    expect(sock.sentOfType('playback.load')).toEqual([])
  })
})

describe('reconnecting', () => {
  it('backs off 0.5s, 1s, 2s, 4s, then 8s between failed attempts', () => {
    const client = makeClient()
    join(client).serverClose(1006)

    const waits: number[] = []
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(client.status).toEqual({ kind: 'reconnecting', attempt })
      const before = FakeSocket.all.length
      let waited = 0
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(100)
        waited += 100
      }
      waits.push(waited)
      FakeSocket.latest().serverClose(1006) // the attempt fails
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000])
  })

  it('resumes with the latest token and starts the backoff over after a welcome', () => {
    const client = makeClient()
    join(client, 'token-1').serverClose(1006)
    vi.advanceTimersByTime(500)
    FakeSocket.latest().serverClose(1006)
    vi.advanceTimersByTime(1000)

    const sock = FakeSocket.latest()
    sock.open()
    expect(sock.sent[0]).toMatchObject({ type: 'hello', resumeToken: 'token-1' })
    sock.receive(welcome('me', 'token-1'))
    expect(client.status).toEqual({ kind: 'open' })

    sock.serverClose(1006)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
    vi.advanceTimersByTime(500)
    expect(FakeSocket.all).toHaveLength(4)
  })

  it.each([
    [4001, 'replaced'],
    [4404, 'not_found'],
    [4409, 'room_full'],
    [4400, 'rejected'],
    [1000, 'left'],
  ])('stops for good on close code %i (%s)', (code, reason) => {
    const client = makeClient()
    const sock = FakeSocket.latest()
    sock.open()
    sock.serverClose(code)
    expect(client.status).toEqual({ kind: 'closed', reason })
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('stops for good when replaced by another tab while open', () => {
    const client = makeClient()
    join(client).serverClose(4001)
    expect(client.status).toEqual({ kind: 'closed', reason: 'replaced' })
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('ignores a late event from a socket it has given up on', () => {
    const client = makeClient()
    const first = join(client)
    first.serverClose(1006)
    vi.advanceTimersByTime(500)
    const second = FakeSocket.latest()
    second.open()
    second.receive(welcome())

    first.receive({ type: 'participant.left', id: 'me' })
    first.serverClose(4409)
    expect(client.status).toEqual({ kind: 'open' })
  })

  it('gives up on a connection that never gets a welcome', () => {
    const client = makeClient()
    FakeSocket.latest().open()
    vi.advanceTimersByTime(WELCOME_TIMEOUT_MS)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
    expect(FakeSocket.all[0].closed).toBe(true)
  })
})

describe('leaving', () => {
  it('sends leave, closes the socket, and never reconnects', () => {
    const client = makeClient()
    const sock = join(client)
    client.leave()
    expect(sock.sent.at(-1)).toEqual({ type: 'leave' })
    expect(sock.closed).toBe(true)
    expect(client.status).toEqual({ kind: 'closed', reason: 'left' })
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('stops retrying when leaving while reconnecting', () => {
    const client = makeClient()
    join(client).serverClose(1006)
    client.leave()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(client.status).toEqual({ kind: 'closed', reason: 'left' })
  })
})

describe('clock offset', () => {
  it('pings five times, one at a time, and keeps the fastest round trip', () => {
    const client = makeClient()
    const sock = join(client)
    expect(client.clockOffsetMs).toBeNull()

    // The server is 5000ms ahead. Replies with a long round trip are also
    // lopsided, so they would give a worse estimate.
    const rtts = [120, 40, 300, 20, 90]
    const skews = [30, 8, -100, 0, 15]
    for (let i = 0; i < 5; i++) {
      const pings = sock.sentOfType('ping')
      expect(pings).toHaveLength(i + 1) // the next ping waits for this pong
      const t0 = pings[i].t0 as number
      vi.advanceTimersByTime(rtts[i])
      sock.receive({ type: 'pong', t0, serverTime: t0 + rtts[i] / 2 + 5000 + skews[i] })
    }
    expect(client.clockOffsetMs).toBe(5000)
    expect(client.serverNow()).toBe(Date.now() + 5000)
  })

  it('measures again every 30 seconds', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock, 250)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() + 250 }) // the first ping went out before autoPong
    expect(client.clockOffsetMs).toBe(250)
    const clockPings = () => sock.sentOfType('ping').length

    const afterFirstRound = clockPings()
    expect(afterFirstRound).toBe(5)
    autoPong(sock, -700)
    vi.advanceTimersByTime(CLOCK_INTERVAL_MS)
    expect(client.clockOffsetMs).toBe(-700)
    // Five more for the new round, plus the heartbeats in between.
    expect(clockPings()).toBe(afterFirstRound + 5 + Math.floor(CLOCK_INTERVAL_MS / HEARTBEAT_MS))
  })

  it('treats heartbeat pongs as heartbeats, not clock samples', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock, 100)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() + 100 })
    autoPong(sock, 99_999) // nonsense, but only heartbeats go out now
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    expect(client.clockOffsetMs).toBe(100)
  })
})

describe('heartbeat', () => {
  it('reconnects when a ping gets no answer', () => {
    const client = makeClient()
    join(client) // the first clock ping is never answered
    vi.advanceTimersByTime(PONG_TIMEOUT_MS - 1)
    expect(client.status).toEqual({ kind: 'open' })
    vi.advanceTimersByTime(1)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
    expect(FakeSocket.all[0].closed).toBe(true)
  })

  it('stays open while pongs keep arriving', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() })
    vi.advanceTimersByTime(5 * 60_000)
    expect(client.status).toEqual({ kind: 'open' })
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('reconnects when the server goes quiet between pings', () => {
    const client = makeClient()
    const sock = join(client)
    autoPong(sock)
    sock.receive({ type: 'pong', t0: sock.sent[1].t0, serverTime: Date.now() })
    sock.onSend = null // the connection dies silently
    vi.advanceTimersByTime(HEARTBEAT_MS + PONG_TIMEOUT_MS)
    expect(client.status).toEqual({ kind: 'reconnecting', attempt: 1 })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm --prefix web test -- src/net/client.test.ts`
Expected: FAIL with `Error: Cannot find module './client'`.

- [ ] **Step 4: Write the client**

`web/src/net/client.ts`:

```ts
// RoomClient is the only code that talks to the server. It owns one
// WebSocket at a time: it sends hello, reconnects with backoff, resumes the
// same seat with the resume token, measures the clock offset, and notices a
// connection that has silently died.
import {
  clientMessage,
  CloseCode,
  serverMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageOf,
} from '../protocol/schemas'
import { backoffDelay } from './backoff'
import { bestOffset, sampleFromPong, type ClockSample } from './clock'

export const CLOCK_SAMPLES = 5
export const CLOCK_INTERVAL_MS = 30_000
export const HEARTBEAT_MS = 10_000
export const PONG_TIMEOUT_MS = 5_000
export const WELCOME_TIMEOUT_MS = 10_000

/** Why the client stopped for good. It never reconnects after these. */
export type CloseReason = 'left' | 'replaced' | 'room_full' | 'not_found' | 'rejected'

export type ConnectionStatus =
  | { kind: 'connecting' } // the first attempt, until welcome
  | { kind: 'open' } // welcomed; messages flow
  | { kind: 'reconnecting'; attempt: number } // waiting to retry, or retrying
  | { kind: 'closed'; reason: CloseReason }

const terminalCloses: Record<number, CloseReason> = {
  [CloseCode.Normal]: 'left',
  [CloseCode.Replaced]: 'replaced',
  [CloseCode.BadMessage]: 'rejected',
  [CloseCode.NotFound]: 'not_found',
  [CloseCode.RoomFull]: 'room_full',
}

/** The parts of the browser WebSocket the client uses, so tests can fake it. */
export interface SocketLike {
  onopen: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  send(data: string): void
  close(): void
}

export interface RoomClientOptions {
  url: string
  hello: { name: string; color: string; pageSession: string }
  /** A token from an earlier welcome in this tab; it reclaims the same seat. */
  resumeToken?: string | null
  /** Called with each welcome's token so the caller can keep it across reloads. */
  onResumeToken?: (token: string) => void
  createSocket?: (url: string) => SocketLike
}

type Timer = ReturnType<typeof setTimeout>

export class RoomClient {
  private readonly opts: RoomClientOptions
  private readonly createSocket: (url: string) => SocketLike
  private readonly messageListeners = new Set<(msg: ServerMessage) => void>()
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>()
  private ws: SocketLike | null = null
  private current: ConnectionStatus = { kind: 'connecting' }
  private failures = 0
  private resumeToken: string | undefined
  private offsetMs: number | null = null
  private samples: ClockSample[] = []
  private clockPing: number | null = null // t0 of the clock ping awaiting its pong
  private retryTimer: Timer | undefined
  private clockTimer: Timer | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private replyDeadline: Timer | undefined

  constructor(opts: RoomClientOptions) {
    this.opts = opts
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url))
    this.resumeToken = opts.resumeToken || undefined
  }

  get status(): ConnectionStatus {
    return this.current
  }

  /** Server clock minus local clock in ms, or null until first measured. */
  get clockOffsetMs(): number | null {
    return this.offsetMs
  }

  /** The server's current time in Unix ms. */
  serverNow(): number {
    return Date.now() + (this.offsetMs ?? 0)
  }

  /** Every valid server message, in order. Returns an unsubscribe function. */
  subscribe(listener: (msg: ServerMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  connect(): void {
    if (this.ws === null && this.retryTimer === undefined && this.current.kind !== 'closed') this.open()
  }

  /**
   * Sends a message if the room is joined. Returns false, sending nothing,
   * while connecting or reconnecting, or if the message would be rejected.
   */
  send(msg: ClientMessage): boolean {
    if (this.current.kind !== 'open') return false
    const checked = clientMessage.safeParse(msg)
    if (!checked.success) {
      console.error('Not sending an invalid message', msg, checked.error.issues)
      return false
    }
    this.raw(checked.data)
    return true
  }

  /** Leaves on purpose: the server frees the seat at once. */
  leave(): void {
    if (this.current.kind === 'closed') return
    if (this.current.kind === 'open') this.raw({ type: 'leave' })
    this.finish('left')
  }

  private open(): void {
    const ws = this.createSocket(this.opts.url)
    this.ws = ws
    ws.onopen = () => {
      this.raw({ type: 'hello', ...this.opts.hello, ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}) })
    }
    ws.onmessage = (ev) => this.receive(ev.data)
    ws.onclose = (ev) => this.socketClosed(ev.code)
    // Covers a server that never answers, and a connection attempt that hangs.
    this.expectReply(WELCOME_TIMEOUT_MS)
  }

  private raw(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg))
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      console.warn('Ignoring a message that is not JSON', data)
      return
    }
    const parsed = serverMessage.safeParse(json)
    if (!parsed.success) {
      console.warn('Ignoring a message the client does not understand', json, parsed.error.issues)
      return
    }
    const msg = parsed.data
    // Anything from the server proves the connection is alive.
    clearTimeout(this.replyDeadline)
    this.replyDeadline = undefined
    if (msg.type === 'welcome') this.welcomed(msg)
    if (msg.type === 'pong') this.pong(msg)
    for (const listener of this.messageListeners) listener(msg)
  }

  private welcomed(msg: ServerMessageOf<'welcome'>): void {
    this.failures = 0
    this.resumeToken = msg.resumeToken
    this.opts.onResumeToken?.(msg.resumeToken)
    this.setStatus({ kind: 'open' })
    this.startClockRound()
    this.heartbeatTimer = setInterval(() => this.ping(false), HEARTBEAT_MS)
  }

  // State is set before sending, so even an instant reply finds it.
  private ping(forClock: boolean): void {
    const t0 = Date.now()
    if (forClock) this.clockPing = t0
    this.expectReply(PONG_TIMEOUT_MS)
    this.raw({ type: 'ping', t0 })
  }

  private startClockRound(): void {
    this.samples = []
    this.ping(true)
  }

  // Clock pings go one at a time, so no ping waits in a queue behind another.
  private pong(msg: ServerMessageOf<'pong'>): void {
    if (msg.t0 !== this.clockPing) return // a heartbeat, not part of a round
    this.samples.push(sampleFromPong(msg.t0, Date.now(), msg.serverTime))
    if (this.samples.length < CLOCK_SAMPLES) {
      this.ping(true)
      return
    }
    this.clockPing = null
    this.offsetMs = bestOffset(this.samples)
    this.clockTimer = setTimeout(() => this.startClockRound(), CLOCK_INTERVAL_MS)
  }

  /** If nothing at all arrives within ms, the connection is treated as dead. */
  private expectReply(ms: number): void {
    this.replyDeadline ??= setTimeout(() => {
      this.replyDeadline = undefined
      console.warn('The server stopped answering; reconnecting')
      this.retry()
    }, ms)
  }

  private socketClosed(code: number): void {
    const reason = terminalCloses[code]
    if (reason) this.finish(reason)
    else this.retry()
  }

  private retry(): void {
    this.dropSocket()
    this.failures += 1
    this.setStatus({ kind: 'reconnecting', attempt: this.failures })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.open()
    }, backoffDelay(this.failures - 1))
  }

  private finish(reason: CloseReason): void {
    this.dropSocket()
    this.setStatus({ kind: 'closed', reason })
  }

  // Detaches the socket first, so a late event from it can't affect the
  // client, then closes it. Also stops every timer.
  private dropSocket(): void {
    const ws = this.ws
    this.ws = null
    clearTimeout(this.retryTimer)
    clearTimeout(this.clockTimer)
    clearTimeout(this.replyDeadline)
    clearInterval(this.heartbeatTimer)
    this.retryTimer = this.clockTimer = this.replyDeadline = this.heartbeatTimer = undefined
    this.clockPing = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null
      ws.close()
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.current = status
    for (const listener of this.statusListeners) listener(status)
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm --prefix web test -- src/net/client.test.ts`
Expected: `Tests  25 passed (25)`.

- [ ] **Step 6: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: no output. This also checks that the browser `WebSocket` type is assignable to `SocketLike`.

- [ ] **Step 7: Commit**

```bash
git add web/src/net/client.ts web/src/net/client.test.ts web/src/test
git commit -m "feat(web): RoomClient with handshake, backoff, close codes, clock offset and heartbeat"
```

---

### Task 5: RoomClient against the real Go server

**Files:**
- Test: `web/src/net/client.server.test.ts`

**Interfaces:**
- Consumes: `RoomClient`, `SocketLike` (Task 4); `randomId`, `roomSocketUrl` (Task 3); the Go server binary from plan 1; Node 25's global `WebSocket` and `fetch`.
- Produces: a contract test that's skipped unless `POPCORN_SERVER` is set. Plan 6 runs it in CI against the built server.

This proves that the TypeScript client and the Go server agree on real traffic:
- the real `welcome` passes the schema
- the polite roles differ
- `leave` frees the seat at once
- 4409, 4404 and 4001 map to the right final states
- a dropped socket resumes the same participant ID

Node's `WebSocket` sends no `Origin` header, so the server's same-origin check lets it through. Task 12 checks the Origin path itself through the Vite proxy.

- [ ] **Step 1: Write the test**

`web/src/net/client.server.test.ts`:

```ts
// RoomClient against the real Go server. Skipped unless POPCORN_SERVER is
// set, for example:
//   POPCORN_SERVER=http://localhost:8099 npx vitest run src/net/client.server.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../protocol/schemas'
import { RoomClient, type SocketLike } from './client'
import { randomId } from './ids'
import { roomSocketUrl } from './url'

const base = process.env.POPCORN_SERVER
const opened: RoomClient[] = []

async function createRoom(): Promise<string> {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST' })
  expect(res.status).toBe(201)
  return ((await res.json()) as { roomId: string }).roomId
}

function connect(roomId: string, name: string, extra: { resumeToken?: string; sockets?: SocketLike[] } = {}) {
  const messages: ServerMessage[] = []
  const client = new RoomClient({
    url: roomSocketUrl(new URL(base!), roomId),
    hello: { name, color: '#e4572e', pageSession: randomId() },
    resumeToken: extra.resumeToken,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      extra.sockets?.push(ws)
      return ws
    },
  })
  client.subscribe((m) => messages.push(m))
  client.connect()
  opened.push(client)
  return { client, messages }
}

function welcomeOf(messages: ServerMessage[]) {
  const w = messages.find((m) => m.type === 'welcome')
  if (!w) throw new Error('no welcome yet')
  return w
}

const waitOpts = { timeout: 3000, interval: 20 }

afterEach(() => {
  for (const c of opened.splice(0)) c.leave()
})

describe.skipIf(!base)('RoomClient against the Go server', () => {
  it('joins, sees the partner arrive, and frees the seat on leave', async () => {
    const roomId = await createRoom()
    const a = connect(roomId, 'Alex')
    await vi.waitFor(() => expect(a.client.status.kind).toBe('open'), waitOpts)
    const b = connect(roomId, 'Sam')
    await vi.waitFor(() => expect(b.client.status.kind).toBe('open'), waitOpts)

    const bWelcome = welcomeOf(b.messages)
    expect(bWelcome.snapshot.participants.map((p) => p.name)).toEqual(['Alex', 'Sam'])
    expect(bWelcome.polite).toBe(!welcomeOf(a.messages).polite)
    await vi.waitFor(() => expect(a.messages.some((m) => m.type === 'participant.joined')).toBe(true), waitOpts)

    b.client.leave()
    expect(b.client.status).toEqual({ kind: 'closed', reason: 'left' })
    await vi.waitFor(
      () => expect(a.messages.some((m) => m.type === 'participant.left' && m.id === bWelcome.you)).toBe(true),
      waitOpts,
    )
    // The seat is free at once, so a third person fits.
    const c = connect(roomId, 'Kim')
    await vi.waitFor(() => expect(c.client.status.kind).toBe('open'), waitOpts)
  })

  it('measures a clock offset near zero against a local server', async () => {
    const roomId = await createRoom()
    const a = connect(roomId, 'Alex')
    await vi.waitFor(() => expect(a.client.clockOffsetMs).not.toBeNull(), waitOpts)
    expect(Math.abs(a.client.clockOffsetMs!)).toBeLessThan(50)
  })

  it('reports room_full to a third person', async () => {
    const roomId = await createRoom()
    const a = connect(roomId, 'Alex')
    const b = connect(roomId, 'Sam')
    await vi.waitFor(() => expect([a.client.status.kind, b.client.status.kind]).toEqual(['open', 'open']), waitOpts)
    const c = connect(roomId, 'Kim')
    await vi.waitFor(() => expect(c.client.status).toEqual({ kind: 'closed', reason: 'room_full' }), waitOpts)
    expect(c.messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'room_full' }))
  })

  it('reports not_found for an unknown room', async () => {
    const a = connect('AAAAAAAAAAAAAAAAAAAAAA', 'Alex')
    await vi.waitFor(() => expect(a.client.status).toEqual({ kind: 'closed', reason: 'not_found' }), waitOpts)
  })

  it('gets the same seat back after its connection drops', async () => {
    const roomId = await createRoom()
    const sockets: SocketLike[] = []
    const a = connect(roomId, 'Alex', { sockets })
    const b = connect(roomId, 'Sam')
    await vi.waitFor(() => expect([a.client.status.kind, b.client.status.kind]).toEqual(['open', 'open']), waitOpts)
    const me = welcomeOf(a.messages).you

    sockets[0].close() // the network drops
    await vi.waitFor(() => expect(a.client.status.kind).toBe('reconnecting'), waitOpts)
    await vi.waitFor(() => expect(a.client.status.kind).toBe('open'), waitOpts)
    const welcomes = a.messages.filter((m) => m.type === 'welcome')
    expect(welcomes).toHaveLength(2)
    expect(welcomes[1].you).toBe(me)
    expect(b.messages.map((m) => m.type)).toContain('participant.reconnecting')
  })

  it('a second tab with the same token takes over, and the first stops for good', async () => {
    const roomId = await createRoom()
    const first = connect(roomId, 'Alex')
    await vi.waitFor(() => expect(first.client.status.kind).toBe('open'), waitOpts)
    const token = welcomeOf(first.messages).resumeToken

    const second = connect(roomId, 'Alex', { resumeToken: token })
    await vi.waitFor(() => expect(second.client.status.kind).toBe('open'), waitOpts)
    await vi.waitFor(() => expect(first.client.status).toEqual({ kind: 'closed', reason: 'replaced' }), waitOpts)
    expect(welcomeOf(second.messages).you).toBe(welcomeOf(first.messages).you)
  })
})
```

- [ ] **Step 2: Run it without a server (skipped)**

Run: `npm --prefix web test -- src/net/client.server.test.ts`
Expected: `Test Files  1 skipped (1)` and `Tests  6 skipped (6)`.

- [ ] **Step 3: Run it against the Go server**

```bash
GOTOOLCHAIN=local go -C server build -o bin/popcorn ./cmd/server
PORT=8099 server/bin/popcorn &
SERVER_PID=$!
sleep 1
POPCORN_SERVER=http://localhost:8099 npm --prefix web test -- src/net/client.server.test.ts
POPCORN_SERVER=http://localhost:8099 npm --prefix web test -- src/net/client.server.test.ts
POPCORN_SERVER=http://localhost:8099 npm --prefix web test -- src/net/client.server.test.ts
kill $SERVER_PID
```

Expected: `Tests  6 passed (6)` on all three runs, each in under about 1 second. The server logs the `TURN is not configured` warning; that's expected.

- [ ] **Step 4: Commit**

```bash
git add web/src/net/client.server.test.ts
git commit -m "test(web): RoomClient contract test against the real Go server"
```

---

### Task 6: Room state reducer and store

**Files:**
- Create: `web/src/app/roomState.ts`, `web/src/app/store.ts`
- Test: `web/src/app/roomState.test.ts`

**Interfaces:**
- Consumes: the protocol types (Task 1); `ConnectionStatus` (Task 4); `welcome()` from `web/src/test/fakeSocket.ts` (Task 4).
- Produces:
  - `interface RoomState { you; polite; iceServers; participants: SnapshotParticipant[]; playback; cams: Record<string, CamState>; stickyStrokes }`
  - `applyServerMessage(room: RoomState | null, msg: ServerMessage): RoomState | null`. It's pure. Messages that aren't room state (`pong`, `cursor`, `cursor.hide`, `ink.points`, `ink.end`, `signal`, `error`) return the **same object**.
  - `SessionStatus = {kind:'idle'} | ConnectionStatus`
  - `interface AppState { roomId: string | null; status: SessionStatus; room: RoomState | null }`
  - `initialAppState`
  - `useAppStore`, a Zustand hook with no actions. Only `session.ts` (Task 9) calls `setState`.

- [ ] **Step 1: Write the failing test**

`web/src/app/roomState.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../protocol/schemas'
import { welcome } from '../test/fakeSocket'
import { applyServerMessage, type RoomState } from './roomState'

const sam = { id: 'p2', name: 'Sam', color: '#2e86ab', pageSession: 'ps-2' }

function start(): RoomState {
  return applyServerMessage(null, welcome('me') as ServerMessage)!
}

function apply(room: RoomState, ...msgs: unknown[]): RoomState {
  return msgs.reduce<RoomState>((r, m) => applyServerMessage(r, m as ServerMessage)!, room)
}

describe('applyServerMessage', () => {
  it('builds the room from welcome', () => {
    const room = start()
    expect(room.you).toBe('me')
    expect(room.polite).toBe(false)
    expect(room.participants.map((p) => p.id)).toEqual(['me'])
    expect(room.playback.videoId).toBeNull()
    expect(Object.keys(room.cams)).toEqual(['me'])
  })

  it('ignores everything before the first welcome', () => {
    expect(applyServerMessage(null, { type: 'participant.joined', participant: sam })).toBeNull()
  })

  it('adds a partner who joins, with their cam', () => {
    const room = apply(start(), { type: 'participant.joined', participant: sam }, {
      type: 'cam',
      camId: 'p2',
      rect: { x: 0.76, y: 0.745, w: 0.22, h: 0.22 },
      holder: null,
    })
    expect(room.participants).toEqual([room.participants[0], { ...sam, connected: true }])
    expect(room.cams.p2.rect.x).toBe(0.76)
  })

  it('marks a partner reconnecting, then back with their new page session', () => {
    let room = apply(start(), { type: 'participant.joined', participant: sam })
    room = apply(room, { type: 'participant.reconnecting', id: 'p2' })
    expect(room.participants[1].connected).toBe(false)
    room = apply(room, { type: 'participant.joined', participant: { ...sam, pageSession: 'ps-3' } })
    expect(room.participants).toHaveLength(2)
    expect(room.participants[1]).toEqual({ ...sam, pageSession: 'ps-3', connected: true })
  })

  it('removes a partner who leaves, and their cam', () => {
    const room = apply(
      start(),
      { type: 'participant.joined', participant: sam },
      { type: 'cam', camId: 'p2', rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, holder: null },
      { type: 'participant.left', id: 'p2' },
    )
    expect(room.participants.map((p) => p.id)).toEqual(['me'])
    expect(room.cams.p2).toBeUndefined()
  })

  it('replaces playback and cam state with the broadcast', () => {
    const state = { videoId: 'dQw4w9WgXcQ', playing: true, position: 3, updatedAt: 1, waitingFor: null, autoResume: false }
    const room = apply(
      start(),
      { type: 'playback', state },
      { type: 'cam', camId: 'me', rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, holder: 'p2' },
    )
    expect(room.playback).toEqual(state)
    expect(room.cams.me).toEqual({ rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, holder: 'p2' })
  })

  it('empties sticky ink on ink.clear', () => {
    const w = welcome('me') as ServerMessage & { type: 'welcome' }
    w.snapshot.stickyStrokes = [{ id: 's1', author: 'me', color: '#e4572e', width: 0.004, points: [[0.1, 0.1]] }]
    const room = apply(applyServerMessage(null, w)!, { type: 'ink.clear', from: 'p2' })
    expect(room.stickyStrokes).toEqual([])
  })

  it('a later welcome (a resume) replaces the whole room', () => {
    const room = apply(start(), { type: 'participant.joined', participant: sam })
    const resumed = apply(room, welcome('me'))
    expect(resumed.participants.map((p) => p.id)).toEqual(['me'])
  })

  it('returns the same object for messages that are not room state', () => {
    const room = start()
    for (const msg of [
      { type: 'pong', t0: 1, serverTime: 2 },
      { type: 'cursor', from: 'p2', x: 0.5, y: 0.5 },
      { type: 'cursor.hide', from: 'p2' },
      { type: 'ink.end', from: 'p2', strokeId: 's1' },
      { type: 'signal', from: 'p2', data: { candidate: {} } },
      { type: 'error', code: 'rate_limited', message: 'slow down' },
    ]) {
      expect(applyServerMessage(room, msg as ServerMessage)).toBe(room)
    }
  })

  it('does not modify the previous state', () => {
    const room = start()
    const before = structuredClone(room)
    apply(room, { type: 'participant.joined', participant: sam }, { type: 'participant.left', id: 'me' })
    expect(room).toEqual(before)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix web test -- src/app/roomState.test.ts`
Expected: FAIL with `Error: Cannot find module './roomState'`.

- [ ] **Step 3: Write the reducer and the store**

`web/src/app/roomState.ts`:

```ts
// The client's copy of the room, rebuilt from server messages only. Local
// in-progress gestures (dragging a cam, drawing) live with the components
// doing them, not here.
import type {
  CamState,
  IceServer,
  PlaybackState,
  ServerMessage,
  SnapshotParticipant,
  Stroke,
} from '../protocol/schemas'

export interface RoomState {
  you: string
  polite: boolean
  iceServers: IceServer[]
  participants: SnapshotParticipant[]
  playback: PlaybackState
  cams: Record<string, CamState>
  stickyStrokes: Stroke[]
}

/**
 * The room after msg. Messages that don't change room state (pongs,
 * cursors, live ink, signals, errors) return the same object, so subscribers
 * don't re-render. Sticky ink.points are added in plan 5, with the server's
 * trimming rules.
 */
export function applyServerMessage(room: RoomState | null, msg: ServerMessage): RoomState | null {
  if (msg.type === 'welcome') {
    return {
      you: msg.you,
      polite: msg.polite,
      iceServers: msg.iceServers,
      participants: msg.snapshot.participants,
      playback: msg.snapshot.playback,
      cams: msg.snapshot.cams,
      stickyStrokes: msg.snapshot.stickyStrokes,
    }
  }
  if (room === null) return null // nothing applies before the first welcome
  switch (msg.type) {
    case 'participant.joined': {
      const joined = { ...msg.participant, connected: true }
      const exists = room.participants.some((p) => p.id === joined.id)
      return {
        ...room,
        participants: exists
          ? room.participants.map((p) => (p.id === joined.id ? joined : p))
          : [...room.participants, joined],
      }
    }
    case 'participant.reconnecting':
      return {
        ...room,
        participants: room.participants.map((p) => (p.id === msg.id ? { ...p, connected: false } : p)),
      }
    case 'participant.left': {
      const cams = { ...room.cams }
      delete cams[msg.id]
      return { ...room, participants: room.participants.filter((p) => p.id !== msg.id), cams }
    }
    case 'playback':
      return { ...room, playback: msg.state }
    case 'cam':
      return { ...room, cams: { ...room.cams, [msg.camId]: { rect: msg.rect, holder: msg.holder } } }
    case 'ink.clear':
      return { ...room, stickyStrokes: [] }
    default:
      return room
  }
}
```

`web/src/app/store.ts`:

```ts
import { create } from 'zustand'
import type { ConnectionStatus } from '../net/client'
import type { RoomState } from './roomState'

/** idle: not joined (the lobby). Otherwise the RoomClient's status. */
export type SessionStatus = { kind: 'idle' } | ConnectionStatus

export interface AppState {
  roomId: string | null
  status: SessionStatus
  room: RoomState | null
}

export const initialAppState: AppState = { roomId: null, status: { kind: 'idle' }, room: null }

/** Written only by session.ts, from server messages and connection status. */
export const useAppStore = create<AppState>()(() => initialAppState)
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix web test -- src/app/roomState.test.ts`
Expected: `Tests  10 passed (10)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/roomState.ts web/src/app/roomState.test.ts web/src/app/store.ts
git commit -m "feat(web): room state reducer over server messages, and the app store"
```

---

### Task 7: Storage, profile and local media

**Files:**
- Create: `web/src/app/storage.ts`, `web/src/app/prefs.ts`, `web/src/app/media.ts`
- Test: `web/src/app/prefs.test.ts`, `web/src/app/media.test.ts`

**Interfaces:**
- Consumes: `MAX_NAME_CHARS`, `nameLength` (Task 1).
- Produces:
  - **Storage:**
    - `type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>`
    - `browserStorage('localStorage' | 'sessionStorage'): StorageLike`, which falls back to memory when storage is blocked and has writes that never throw
    - `memoryStorage(): StorageLike`
  - **Profile:**
    - `PALETTE`, 6 colors
    - `interface Profile { name; color }`
    - `isValidName(name)`
    - `loadProfile(storage, random = Math.random): Profile`
    - `saveProfile(storage, profile)`, which trims the name
  - **Media:**
    - `type LocalMedia = {status:'pending'} | {status:'ready'; stream; hasVideo; hasAudio} | {status:'blocked'} | {status:'unavailable'}`
    - `acquireLocalMedia(devices = navigator.mediaDevices): Promise<LocalMedia>`. Calls share one request, which matters because React StrictMode runs effects twice in development.
    - `releaseLocalMedia()`, which stops every track, even if the request was still pending
    - `useLocalMedia(): [LocalMedia, retry]`

How media requests behave:
- It first asks for `{video: true, audio: {echoCancellation: true, noiseSuppression: true}}`.
- `NotAllowedError` or `SecurityError` means `blocked`, with no second prompt.
- Any other failure, such as no camera or a camera in use, retries with audio only.
- If there's no `getUserMedia` at all, the result is `unavailable`.

- [ ] **Step 1: Write the failing tests**

`web/src/app/prefs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isValidName, loadProfile, PALETTE, saveProfile } from './prefs'
import { memoryStorage } from './storage'

describe('profile', () => {
  it('round-trips through storage, trimming the name', () => {
    const storage = memoryStorage()
    saveProfile(storage, { name: '  Sam ', color: PALETTE[3] })
    expect(loadProfile(storage)).toEqual({ name: 'Sam', color: PALETTE[3] })
  })

  it('starts with no name and a palette color picked at random', () => {
    expect(loadProfile(memoryStorage(), () => 0)).toEqual({ name: '', color: PALETTE[0] })
    expect(loadProfile(memoryStorage(), () => 0.99)).toEqual({ name: '', color: PALETTE[PALETTE.length - 1] })
  })

  it('ignores a color that is not in the palette and data that is not a profile', () => {
    const storage = memoryStorage()
    storage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: '#000000' }))
    expect(loadProfile(storage, () => 0)).toEqual({ name: 'Sam', color: PALETTE[0] })
    storage.setItem('popcorn.profile', '{broken')
    expect(loadProfile(storage, () => 0)).toEqual({ name: '', color: PALETTE[0] })
    storage.setItem('popcorn.profile', '42')
    expect(loadProfile(storage, () => 0)).toEqual({ name: '', color: PALETTE[0] })
  })
})

describe('isValidName', () => {
  it('needs 1 to 32 characters after trimming', () => {
    expect(isValidName('')).toBe(false)
    expect(isValidName('   ')).toBe(false)
    expect(isValidName('A')).toBe(true)
    expect(isValidName('a'.repeat(32))).toBe(true)
    expect(isValidName('a'.repeat(33))).toBe(false)
    expect(isValidName('🍿'.repeat(32))).toBe(true)
  })
})
```

`web/src/app/media.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireLocalMedia, releaseLocalMedia } from './media'

function fakeStream(kinds: Array<'video' | 'audio'>) {
  const tracks = kinds.map((kind) => ({ kind, stop: vi.fn() }))
  return {
    tracks,
    stream: {
      getTracks: () => tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    } as unknown as MediaStream,
  }
}

const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
const noCamera = Object.assign(new Error('none'), { name: 'NotFoundError' })

afterEach(() => releaseLocalMedia())

describe('acquireLocalMedia', () => {
  it('opens camera and mic with echo cancellation and noise suppression', async () => {
    const { stream } = fakeStream(['video', 'audio'])
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toEqual({
      status: 'ready',
      stream,
      hasVideo: true,
      hasAudio: true,
    })
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: { echoCancellation: true, noiseSuppression: true } })
  })

  it('falls back to the mic alone when there is no camera', async () => {
    const { stream } = fakeStream(['audio'])
    const getUserMedia = vi.fn().mockRejectedValueOnce(noCamera).mockResolvedValueOnce(stream)
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toMatchObject({ status: 'ready', hasVideo: false })
  })

  it('reports blocked when permission is denied, without asking twice', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(denied)
    await expect(acquireLocalMedia({ getUserMedia })).resolves.toEqual({ status: 'blocked' })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable without getUserMedia or without devices', async () => {
    await expect(acquireLocalMedia(undefined)).resolves.toEqual({ status: 'unavailable' })
    releaseLocalMedia()
    await expect(acquireLocalMedia({ getUserMedia: vi.fn().mockRejectedValue(noCamera) })).resolves.toEqual({
      status: 'unavailable',
    })
  })

  it('shares one request between callers (React runs effects twice in development)', async () => {
    const { stream } = fakeStream(['video', 'audio'])
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    const [a, b] = await Promise.all([acquireLocalMedia({ getUserMedia }), acquireLocalMedia({ getUserMedia })])
    expect(a).toBe(b)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('stops every track on release, even if the request was still pending', async () => {
    const { stream, tracks } = fakeStream(['video', 'audio'])
    let resolve!: (s: MediaStream) => void
    acquireLocalMedia({ getUserMedia: () => new Promise((r) => (resolve = r)) })
    releaseLocalMedia()
    resolve(stream)
    await vi.waitFor(() => expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true))
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web test -- src/app/prefs.test.ts src/app/media.test.ts`
Expected: both files FAIL with `Error: Cannot find module` (`./prefs` or `./storage`, and `./media`).

- [ ] **Step 3: Write storage, prefs and media**

`web/src/app/storage.ts`:

```ts
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * localStorage or sessionStorage, or an in-memory stand-in when the browser
 * blocks storage (some private modes do). Writes never throw.
 */
export function browserStorage(kind: 'localStorage' | 'sessionStorage'): StorageLike {
  try {
    const storage = globalThis[kind]
    storage.setItem('popcorn.probe', '1')
    storage.removeItem('popcorn.probe')
    return {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => {
        try {
          storage.setItem(key, value)
        } catch {
          // Full or blocked: remembering is a convenience, not a requirement.
        }
      },
      removeItem: (key) => storage.removeItem(key),
    }
  } catch {
    return memoryStorage()
  }
}

export function memoryStorage(): StorageLike {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  }
}
```

`web/src/app/prefs.ts`:

```ts
// The name and color someone picks in the lobby, remembered in localStorage.
import { MAX_NAME_CHARS, nameLength } from '../protocol/schemas'
import type { StorageLike } from './storage'

export const PALETTE = ['#e4572e', '#f2a541', '#59a96a', '#2e86ab', '#7b6cf6', '#e055a5'] as const

const KEY = 'popcorn.profile'

export interface Profile {
  name: string
  color: string
}

export function isValidName(name: string): boolean {
  const n = nameLength(name)
  return n >= 1 && n <= MAX_NAME_CHARS
}

/** The saved profile, or an empty name and a random palette color. */
export function loadProfile(storage: StorageLike, random: () => number = Math.random): Profile {
  const fallback: Profile = { name: '', color: PALETTE[Math.floor(random() * PALETTE.length)] }
  let saved: unknown
  try {
    saved = JSON.parse(storage.getItem(KEY) ?? 'null')
  } catch {
    return fallback
  }
  if (typeof saved !== 'object' || saved === null) return fallback
  const { name, color } = saved as Record<string, unknown>
  return {
    name: typeof name === 'string' ? name : '',
    color: typeof color === 'string' && (PALETTE as readonly string[]).includes(color) ? color : fallback.color,
  }
}

export function saveProfile(storage: StorageLike, profile: Profile): void {
  storage.setItem(KEY, JSON.stringify({ name: profile.name.trim(), color: profile.color }))
}
```

`web/src/app/media.ts`:

```ts
// The camera and mic, opened in the lobby and kept for the call (plan 4).
import { useCallback, useEffect, useState } from 'react'

export type LocalMedia =
  | { status: 'pending' }
  | { status: 'ready'; stream: MediaStream; hasVideo: boolean; hasAudio: boolean }
  | { status: 'blocked' } // the person or the browser said no
  | { status: 'unavailable' } // no devices, or no getUserMedia (plain-http LAN address)

type Devices = Pick<MediaDevices, 'getUserMedia'> | undefined

const audio = { echoCancellation: true, noiseSuppression: true }

let current: Promise<LocalMedia> | null = null

/** Opens the camera and mic once; later calls share the same result. */
export function acquireLocalMedia(devices: Devices = globalThis.navigator?.mediaDevices): Promise<LocalMedia> {
  current ??= request(devices)
  return current
}

/** Turns the camera and mic off. The next acquire asks again. */
export function releaseLocalMedia(): void {
  const old = current
  current = null
  void old?.then((m) => {
    if (m.status === 'ready') for (const track of m.stream.getTracks()) track.stop()
  })
}

async function request(devices: Devices): Promise<LocalMedia> {
  if (!devices?.getUserMedia) return { status: 'unavailable' }
  try {
    return ready(await devices.getUserMedia({ video: true, audio }))
  } catch (err) {
    if (isDenied(err)) return { status: 'blocked' }
  }
  // No camera, or another app has it: the mic alone still makes a call.
  try {
    return ready(await devices.getUserMedia({ audio }))
  } catch (err) {
    return isDenied(err) ? { status: 'blocked' } : { status: 'unavailable' }
  }
}

function ready(stream: MediaStream): LocalMedia {
  return {
    status: 'ready',
    stream,
    hasVideo: stream.getVideoTracks().length > 0,
    hasAudio: stream.getAudioTracks().length > 0,
  }
}

function isDenied(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'NotAllowedError' || name === 'SecurityError'
}

/** The local media for a component, plus a retry that asks again. */
export function useLocalMedia(): [LocalMedia, () => void] {
  const [media, setMedia] = useState<LocalMedia>({ status: 'pending' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    void acquireLocalMedia().then((m) => {
      if (live) setMedia(m)
    })
    return () => {
      live = false
    }
  }, [attempt])
  const retry = useCallback(() => {
    releaseLocalMedia()
    setMedia({ status: 'pending' })
    setAttempt((a) => a + 1)
  }, [])
  return [media, retry]
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm --prefix web test -- src/app/prefs.test.ts src/app/media.test.ts`
Expected: `Tests  10 passed (10)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/storage.ts web/src/app/prefs.ts web/src/app/prefs.test.ts web/src/app/media.ts web/src/app/media.test.ts
git commit -m "feat(web): remembered profile, safe storage, and camera/mic acquisition"
```

---

### Task 8: Routes and room creation

**Files:**
- Create: `web/src/app/routes.ts`, `web/src/app/api.ts`
- Test: `web/src/app/routes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - **Routing:**
    - `type Route = {page:'landing'} | {page:'room'; roomId} | {page:'unknown'}`
    - `ROOM_ID` (regex)
    - `parseRoute(pathname)`
    - `roomPath(roomId)`
    - `navigate(path)`, which does `pushState` and then fires a `popcorn:navigate` event
    - `useRoute(): Route`, which uses `useSyncExternalStore` on `popstate` and `popcorn:navigate`, and is memoized per pathname
  - **API:** `createRoom(fetchFn = fetch): Promise<string>`. It posts to `/api/rooms`, expects 201 with a valid `roomId`, and rejects with a message written for people otherwise:
    - 503: "Too many rooms are open right now…"
    - a network error: "Couldn't reach the server…"

- [ ] **Step 1: Write the failing test**

`web/src/app/routes.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createRoom } from './api'
import { parseRoute, roomPath } from './routes'

const id = 'Kx81mZq2Tq0Rb2_9sLm0Qa'

describe('parseRoute', () => {
  it.each([
    ['/', { page: 'landing' }],
    [`/r/${id}`, { page: 'room', roomId: id }],
    [`/r/${id}/`, { page: 'room', roomId: id }],
    ['/r/short', { page: 'unknown' }],
    [`/r/${id}x`, { page: 'unknown' }],
    ['/r/', { page: 'unknown' }],
    [`/r/${id}/extra`, { page: 'unknown' }],
    ['/about', { page: 'unknown' }],
  ])('%s', (path, route) => {
    expect(parseRoute(path)).toEqual(route)
  })

  it('round-trips roomPath', () => {
    expect(parseRoute(roomPath(id))).toEqual({ page: 'room', roomId: id })
  })
})

describe('createRoom', () => {
  const reply = (status: number, body: unknown) =>
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }))

  it('posts to /api/rooms and returns the room ID', async () => {
    const fetchFn = reply(201, { roomId: id })
    await expect(createRoom(fetchFn)).resolves.toBe(id)
    expect(fetchFn).toHaveBeenCalledWith('/api/rooms', { method: 'POST' })
  })

  it('explains a full server', async () => {
    await expect(createRoom(reply(503, 'Too many rooms'))).rejects.toThrow('Too many rooms are open right now')
  })

  it('explains other failures', async () => {
    await expect(createRoom(reply(500, {}))).rejects.toThrow('HTTP 500')
    await expect(createRoom(reply(201, { roomId: '../evil' }))).rejects.toThrow("didn't include a room")
    await expect(createRoom(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')))).rejects.toThrow(
      "Couldn't reach the server",
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix web test -- src/app/routes.test.ts`
Expected: FAIL with `Error: Cannot find module './api'`.

- [ ] **Step 3: Write routes and the API call**

`web/src/app/routes.ts`:

```ts
// Two real pages, so a few lines of history handling instead of a router.
import { useMemo, useSyncExternalStore } from 'react'

export type Route = { page: 'landing' } | { page: 'room'; roomId: string } | { page: 'unknown' }

/** Room IDs are 128 random bits, base64url-encoded: 22 characters. */
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { page: 'landing' }
  const m = /^\/r\/([^/]+)\/?$/.exec(pathname)
  if (m && ROOM_ID.test(m[1])) return { page: 'room', roomId: m[1] }
  return { page: 'unknown' }
}

export function roomPath(roomId: string): string {
  return `/r/${roomId}`
}

const NAVIGATE = 'popcorn:navigate'

export function navigate(path: string): void {
  if (path === location.pathname) return
  history.pushState(null, '', path)
  window.dispatchEvent(new Event(NAVIGATE))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE, onChange)
  }
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname)
  return useMemo(() => parseRoute(pathname), [pathname])
}
```

`web/src/app/api.ts`:

```ts
import { ROOM_ID } from './routes'

/** POST /api/rooms. Resolves to the new room's ID; rejects with a message for people. */
export async function createRoom(fetchFn: typeof fetch = fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchFn('/api/rooms', { method: 'POST' })
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.")
  }
  if (res.status === 503) throw new Error('Too many rooms are open right now. Try again in a few minutes.')
  if (res.status !== 201) throw new Error(`Couldn't create a room (HTTP ${res.status}). Try again.`)
  const body: unknown = await res.json().catch(() => null)
  const roomId = (body as { roomId?: unknown } | null)?.roomId
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) {
    throw new Error("The server's reply didn't include a room. Try again.")
  }
  return roomId
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix web test -- src/app/routes.test.ts`
Expected: `Tests  12 passed (12)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/routes.ts web/src/app/api.ts web/src/app/routes.test.ts
git commit -m "feat(web): history-based routes and the create-room request"
```

---

### Task 9: Session (joining, leaving and resume tokens)

**Files:**
- Create: `web/src/app/session.ts`
- Test: `web/src/app/session.test.ts`

**Interfaces:**
- Consumes: `RoomClient`, `SocketLike` (Task 4); `randomId`, `roomSocketUrl` (Task 3); `applyServerMessage`, `useAppStore`, `initialAppState` (Task 6); `browserStorage`, `StorageLike`, `Profile`, `releaseLocalMedia` (Task 7); `Route` (Task 8).
- Produces (`web/src/app/session.ts`):
  - `interface SessionDeps { page?; storage?; createSocket? }`, used by tests
  - `joinRoom(roomId, profile, deps = {})`. It trims the name, resumes with the saved token if there is one, and saves every welcome's token.
  - `leaveRoom()`. It sends `leave`, forgets the token and resets the store to idle.
  - `resetSession()`. It resets the store to idle but keeps the token, which is what **Use this tab instead** needs.
  - `savedResumeToken(roomId, storage?)`
  - `getRoomClient(): RoomClient | null`, which plans 3–5 use to send messages
  - `syncSessionWithRoute(route)`. If the route isn't the joined room, it leaves; if the route isn't a room at all, it releases local media.
- `pageSession` is made once per page load with `randomId()`.
- Listeners from a client that has been replaced are ignored (`active?.client === client`).

- [ ] **Step 1: Write the failing test**

`web/src/app/session.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSocket, welcome } from '../test/fakeSocket'
import { getRoomClient, joinRoom, leaveRoom, resetSession, syncSessionWithRoute } from './session'
import { memoryStorage, type StorageLike } from './storage'
import { useAppStore } from './store'

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'
const profile = { name: '  Alex ', color: '#e4572e' }
let storage: StorageLike

function join() {
  joinRoom(roomId, profile, {
    page: { protocol: 'http:', host: 'localhost:5173' },
    storage,
    createSocket: (url) => new FakeSocket(url),
  })
  return FakeSocket.latest()
}

beforeEach(() => {
  FakeSocket.reset()
  storage = memoryStorage()
  vi.useFakeTimers()
})

afterEach(() => {
  resetSession()
  vi.useRealTimers()
})

describe('session', () => {
  it('joins: connects to the room and fills the store from welcome', () => {
    const sock = join()
    expect(sock.url).toBe(`ws://localhost:5173/ws?room=${roomId}`)
    expect(useAppStore.getState()).toMatchObject({ roomId, status: { kind: 'connecting' }, room: null })

    sock.open()
    expect(sock.sent[0]).toMatchObject({ type: 'hello', name: 'Alex', color: '#e4572e' })
    sock.receive(welcome('me', 'tok-1'))
    expect(useAppStore.getState().status).toEqual({ kind: 'open' })
    expect(useAppStore.getState().room?.you).toBe('me')
    expect(storage.getItem(`popcorn.resume.${roomId}`)).toBe('tok-1')
  })

  it('rejoins with the token saved by an earlier page load', () => {
    storage.setItem(`popcorn.resume.${roomId}`, 'tok-old')
    const sock = join()
    sock.open()
    expect(sock.sent[0]).toMatchObject({ type: 'hello', resumeToken: 'tok-old' })
  })

  it('keeps room state current as messages arrive', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me'))
    sock.receive({ type: 'participant.joined', participant: { id: 'p2', name: 'Sam', color: '#2e86ab', pageSession: 'x' } })
    expect(useAppStore.getState().room?.participants.map((p) => p.name)).toEqual(['Alex', 'Sam'])
  })

  it('leaving sends leave, forgets the token, and empties the store', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me', 'tok-1'))
    leaveRoom()
    expect(sock.sent.at(-1)).toEqual({ type: 'leave' })
    expect(storage.getItem(`popcorn.resume.${roomId}`)).toBeNull()
    expect(useAppStore.getState()).toEqual({ roomId: null, status: { kind: 'idle' }, room: null })
    expect(getRoomClient()).toBeNull()
  })

  it('shows replaced when another tab takes over, and keeps the token for "use this tab"', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me', 'tok-1'))
    sock.serverClose(4001)
    expect(useAppStore.getState().status).toEqual({ kind: 'closed', reason: 'replaced' })
    resetSession()
    expect(useAppStore.getState().status).toEqual({ kind: 'idle' })
    expect(storage.getItem(`popcorn.resume.${roomId}`)).toBe('tok-1')
  })

  it('ignores a replaced client once a new one has started', () => {
    const first = join()
    first.open()
    const second = join() // joining again (e.g. "use this tab") replaces the client
    expect(first.closed).toBe(true)
    first.serverClose(4409)
    second.open()
    second.receive(welcome('me'))
    expect(useAppStore.getState().status).toEqual({ kind: 'open' })
  })

  it('leaves when the person navigates away from the room', () => {
    const sock = join()
    sock.open()
    sock.receive(welcome('me'))
    syncSessionWithRoute({ page: 'room', roomId })
    expect(useAppStore.getState().roomId).toBe(roomId)
    syncSessionWithRoute({ page: 'landing' })
    expect(sock.sent.at(-1)).toEqual({ type: 'leave' })
    expect(useAppStore.getState().roomId).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix web test -- src/app/session.test.ts`
Expected: FAIL with `Error: Cannot find module './session'`.

- [ ] **Step 3: Write the session**

`web/src/app/session.ts`:

```ts
// Wires the RoomClient to the store. Pages call joinRoom and leaveRoom;
// later plans reach the client through getRoomClient to send messages.
import { RoomClient, type SocketLike } from '../net/client'
import { randomId } from '../net/ids'
import { roomSocketUrl } from '../net/url'
import { releaseLocalMedia } from './media'
import type { Profile } from './prefs'
import { applyServerMessage } from './roomState'
import type { Route } from './routes'
import { browserStorage, type StorageLike } from './storage'
import { initialAppState, useAppStore } from './store'

/** One per page load, so the partner can tell a reload from a dropped socket. */
const pageSession = randomId()

export interface SessionDeps {
  page?: { protocol: string; host: string }
  storage?: StorageLike // where resume tokens live; sessionStorage by default
  createSocket?: (url: string) => SocketLike
}

let active: { client: RoomClient; roomId: string; storage: StorageLike } | null = null

const tokenKey = (roomId: string) => `popcorn.resume.${roomId}`

/** The token from an earlier welcome in this tab (it survives a reload). */
export function savedResumeToken(roomId: string, storage = browserStorage('sessionStorage')): string | null {
  return storage.getItem(tokenKey(roomId))
}

export function getRoomClient(): RoomClient | null {
  return active?.client ?? null
}

export function joinRoom(roomId: string, profile: Profile, deps: SessionDeps = {}): void {
  active?.client.leave()
  const storage = deps.storage ?? browserStorage('sessionStorage')
  const client = new RoomClient({
    url: roomSocketUrl(deps.page ?? location, roomId),
    hello: { name: profile.name.trim(), color: profile.color, pageSession },
    resumeToken: storage.getItem(tokenKey(roomId)),
    onResumeToken: (token) => storage.setItem(tokenKey(roomId), token),
    createSocket: deps.createSocket,
  })
  active = { client, roomId, storage }
  useAppStore.setState({ roomId, status: client.status, room: null })
  client.onStatus((status) => {
    if (active?.client === client) useAppStore.setState({ status })
  })
  client.subscribe((msg) => {
    if (active?.client === client) useAppStore.setState((s) => ({ room: applyServerMessage(s.room, msg) }))
  })
  client.connect()
}

/** The Leave button: frees the seat now and forgets the resume token. */
export function leaveRoom(): void {
  if (active) {
    active.client.leave()
    active.storage.removeItem(tokenKey(active.roomId))
  }
  resetSession()
}

/** Back to the lobby without leaving, e.g. to rejoin after another tab took over. */
export function resetSession(): void {
  active = null
  useAppStore.setState(initialAppState)
}

/** Leaving the room's page (Back, or a typed URL) leaves the room and turns the camera off. */
export function syncSessionWithRoute(route: Route): void {
  const routeRoom = route.page === 'room' ? route.roomId : null
  const { roomId } = useAppStore.getState()
  if (roomId !== null && roomId !== routeRoom) leaveRoom()
  if (routeRoom === null) releaseLocalMedia()
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix web test -- src/app/session.test.ts`
Expected: `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/session.ts web/src/app/session.test.ts
git commit -m "feat(web): session wiring between RoomClient and the store, with resume tokens"
```

---

### Task 10: Lobby

**Files:**
- Create: `web/src/app/MediaViews.tsx`, `web/src/app/Lobby.tsx`
- Test: `web/src/app/Lobby.test.tsx` (jsdom)

**Interfaces:**
- Consumes: `MAX_NAME_CHARS` (Task 1); `useLocalMedia`, `LocalMedia`, `PALETTE`, `loadProfile`, `saveProfile`, `isValidName`, `Profile`, `browserStorage` (Task 7); `joinRoom`, `savedResumeToken` (Task 9).
- Produces:
  - `<Lobby roomId joining />`. It has a name input, a color radio group (`aria-label="Color #rrggbb"`), a preview, a headphones tip, and a submit button labeled **Join**, **Rejoin** (when this tab has a token) or **Joining…** (while `joining`).
  - `<VideoView stream mirrored? />`, `<InitialTile name color />` and `<MicMeter stream />`, which plan 4 reuses for cam tiles.

In jsdom, `navigator.mediaDevices` is undefined, so the lobby test sees `unavailable`, the "no camera" path. That's what the test wants.

- [ ] **Step 1: Write the failing test**

`web/src/app/Lobby.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lobby } from './Lobby'
import { PALETTE } from './prefs'
import { joinRoom } from './session'

vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  joinRoom: vi.fn(),
}))

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'
const nameInput = () => screen.getByLabelText<HTMLInputElement>('Your name')

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.mocked(joinRoom).mockClear()
})

afterEach(cleanup)

describe('Lobby', () => {
  it('fills in the remembered name and color', () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: PALETTE[3] }))
    render(<Lobby roomId={roomId} joining={false} />)
    expect(nameInput().value).toBe('Sam')
    expect(screen.getByRole<HTMLInputElement>('radio', { name: `Color ${PALETTE[3]}` }).checked).toBe(true)
  })

  it('needs a name before joining', () => {
    render(<Lobby roomId={roomId} joining={false} />)
    const join = screen.getByRole<HTMLButtonElement>('button', { name: 'Join' })
    expect(join.disabled).toBe(true)
    fireEvent.change(nameInput(), { target: { value: '   ' } })
    expect(join.disabled).toBe(true)
    fireEvent.change(nameInput(), { target: { value: 'Kim' } })
    expect(join.disabled).toBe(false)
  })

  it('joins with the trimmed name and chosen color, and remembers them', () => {
    render(<Lobby roomId={roomId} joining={false} />)
    fireEvent.change(nameInput(), { target: { value: '  Kim  ' } })
    fireEvent.click(screen.getByRole('radio', { name: `Color ${PALETTE[2]}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(joinRoom).toHaveBeenCalledWith(roomId, { name: 'Kim', color: PALETTE[2] })
    expect(JSON.parse(localStorage.getItem('popcorn.profile')!)).toEqual({ name: 'Kim', color: PALETTE[2] })
  })

  it('offers Rejoin after a reload in the same tab', () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: PALETTE[0] }))
    sessionStorage.setItem(`popcorn.resume.${roomId}`, 'tok-1')
    render(<Lobby roomId={roomId} joining={false} />)
    expect(screen.getByRole('heading').textContent).toBe('Welcome back')
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin' }))
    expect(joinRoom).toHaveBeenCalledWith(roomId, { name: 'Sam', color: PALETTE[0] })
  })

  it('shows the initial and still allows joining without a camera', async () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'sam', color: PALETTE[0] }))
    render(<Lobby roomId={roomId} joining={false} />) // jsdom has no getUserMedia
    expect(await screen.findByText('No camera or mic found. You can still join.')).toBeTruthy()
    expect(screen.getByText('S')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join' }).disabled).toBe(false)
  })

  it('shows the headphones tip', () => {
    render(<Lobby roomId={roomId} joining={false} />)
    expect(screen.getByText(/Headphones recommended/)).toBeTruthy()
  })

  it('is busy while joining', () => {
    localStorage.setItem('popcorn.profile', JSON.stringify({ name: 'Sam', color: PALETTE[0] }))
    render(<Lobby roomId={roomId} joining />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Joining…' }).disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --prefix web test -- src/app/Lobby.test.tsx`
Expected: FAIL with `Error: Failed to resolve import "./Lobby" from "src/app/Lobby.test.tsx". Does the file exist?` (Vite's wording for a missing import in a `.tsx` test).

- [ ] **Step 3: Write the media views and the lobby**

`web/src/app/MediaViews.tsx`:

```tsx
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
```

`web/src/app/Lobby.tsx`:

```tsx
import { useState, type FormEvent } from 'react'
import { MAX_NAME_CHARS } from '../protocol/schemas'
import { useLocalMedia, type LocalMedia } from './media'
import { InitialTile, MicMeter, VideoView } from './MediaViews'
import { isValidName, loadProfile, PALETTE, saveProfile, type Profile } from './prefs'
import { joinRoom, savedResumeToken } from './session'
import { browserStorage } from './storage'

export function Lobby({ roomId, joining }: { roomId: string; joining: boolean }) {
  const [profile, setProfile] = useState(() => loadProfile(browserStorage('localStorage')))
  const [media, retryMedia] = useLocalMedia()
  // A token means this tab was in the room before a reload.
  const [rejoining] = useState(() => savedResumeToken(roomId) !== null)
  const canJoin = isValidName(profile.name) && !joining

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!canJoin) return
    const chosen = { name: profile.name.trim(), color: profile.color }
    saveProfile(browserStorage('localStorage'), chosen)
    joinRoom(roomId, chosen)
  }

  return (
    <main className="center-page">
      <form className="card lobby" onSubmit={submit}>
        <Preview media={media} profile={profile} onRetry={retryMedia} />
        <div className="lobby-form">
          <h1>{rejoining ? 'Welcome back' : 'Join the watch party'}</h1>
          <label className="field">
            <span>Your name</span>
            <input
              value={profile.name}
              maxLength={MAX_NAME_CHARS}
              autoComplete="nickname"
              autoFocus
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </label>
          <fieldset className="field swatches">
            <legend>Your color</legend>
            {PALETTE.map((color) => (
              <label key={color} className="swatch" style={{ background: color }}>
                <input
                  type="radio"
                  name="color"
                  value={color}
                  aria-label={`Color ${color}`}
                  checked={profile.color === color}
                  onChange={() => setProfile({ ...profile, color })}
                />
              </label>
            ))}
          </fieldset>
          <p className="tip">🎧 Headphones recommended: without them, the movie can echo back through your mic.</p>
          <button type="submit" className="primary big" disabled={!canJoin}>
            {joining ? 'Joining…' : rejoining ? 'Rejoin' : 'Join'}
          </button>
        </div>
      </form>
    </main>
  )
}

function Preview({ media, profile, onRetry }: { media: LocalMedia; profile: Profile; onRetry: () => void }) {
  const showVideo = media.status === 'ready' && media.hasVideo
  return (
    <div className="preview">
      <div className="preview-frame">
        {showVideo ? <VideoView stream={media.stream} mirrored /> : <InitialTile name={profile.name} color={profile.color} />}
      </div>
      <div className="preview-status">
        {media.status === 'pending' && <span>Asking for your camera and mic…</span>}
        {media.status === 'ready' && (media.hasAudio ? <MicMeter stream={media.stream} /> : <span>No mic found.</span>)}
        {media.status === 'ready' && !media.hasVideo && <span>No camera found. You can still join.</span>}
        {(media.status === 'blocked' || media.status === 'unavailable') && (
          <>
            <span>
              {media.status === 'blocked'
                ? "Camera and mic are blocked. Allow them in your browser's site settings, then retry. You can still join."
                : 'No camera or mic found. You can still join.'}
            </span>
            <button type="button" className="link" onClick={onRetry}>
              Retry camera
            </button>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix web test -- src/app/Lobby.test.tsx`
Expected: `Tests  7 passed (7)`. If every test instead fails with `TypeError: localStorage.clear is not a function`, the `execArgv: ['--no-experimental-webstorage']` line is missing from `vite.config.ts` (Task 1).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/MediaViews.tsx web/src/app/Lobby.tsx web/src/app/Lobby.test.tsx
git commit -m "feat(web): lobby with name, color, camera and mic preview, and Join/Rejoin"
```

---

### Task 11: Landing, room page, toolbar shell, error pages and the app

**Files:**
- Create: `web/src/stage/Stage.tsx`
- Create: `web/src/app/Landing.tsx`, `web/src/app/ErrorPage.tsx`, `web/src/app/Toolbar.tsx`, `web/src/app/RoomPage.tsx`, `web/src/app/RoomRoute.tsx`, `web/src/app/App.tsx`, `web/src/app/styles.css`
- Create: `web/src/main.tsx`
- Test: `web/src/app/RoomRoute.test.tsx`, `web/src/app/App.test.tsx` (jsdom)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - **Stage:** `<Stage>{children}</Stage>`. It fills its parent and centers `fitStage(parent size)`, and a `ResizeObserver` keeps it current. Without `ResizeObserver` (jsdom), it measures once.
  - **`<RoomRoute roomId />`** maps the session status for this room to a page:
    - idle → Lobby
    - connecting, or reconnecting before the first welcome → Lobby with the button busy
    - open or reconnecting with a room → RoomPage
    - closed `left` → Lobby
    - closed with any other reason → ErrorPage
  - **`<ErrorPage kind />`** for `'room_full' | 'not_found' | 'replaced' | 'rejected'`:
    - room full and not found offer **Create room**
    - replaced offers **Use this tab instead**
    - rejected offers **Back to the lobby**
  - **`<CreateRoomButton />`** (in `Landing.tsx`)
  - **`<RoomPage />`**: the stage with a "No video loaded" placeholder, a partner notice ("Waiting for your partner…" with **Copy link**, or "{name} is reconnecting…"), a **Reconnecting…** banner, and the toolbar.
  - **`<Toolbar room />`**: the controls from spec section 5, disabled except **Leave**. It also has a presence list.
  - **`<App />`**: route → page, and runs `syncSessionWithRoute(route)` on every route change.

- [ ] **Step 1: Write the failing tests**

`web/src/app/RoomRoute.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '../protocol/schemas'
import { welcome } from '../test/fakeSocket'
import { applyServerMessage } from './roomState'
import { RoomRoute } from './RoomRoute'
import { initialAppState, useAppStore, type SessionStatus } from './store'

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'
const room = applyServerMessage(null, welcome('me') as ServerMessage)!
const partner = { id: 'p2', name: 'Sam', color: '#2e86ab', pageSession: 'ps-2' }

function show(status: SessionStatus, withRoom = true) {
  useAppStore.setState({ roomId, status, room: withRoom ? room : null })
  render(<RoomRoute roomId={roomId} />)
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState)
})

describe('RoomRoute', () => {
  it('shows the lobby before joining', () => {
    useAppStore.setState(initialAppState)
    render(<RoomRoute roomId={roomId} />)
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy()
  })

  it('keeps the lobby busy until the first welcome, even while retrying', () => {
    show({ kind: 'reconnecting', attempt: 2 }, false)
    expect(screen.getByRole('button', { name: 'Joining…' })).toBeTruthy()
  })

  it('shows the room once joined, waiting for the partner', () => {
    show({ kind: 'open' })
    expect(screen.getByRole('button', { name: 'Leave' })).toBeTruthy()
    expect(screen.getByText("Waiting for your partner. Send them this room's link.")).toBeTruthy()
  })

  it('says when the partner is reconnecting', () => {
    useAppStore.setState({
      roomId,
      status: { kind: 'open' },
      room: { ...room, participants: [...room.participants, { ...partner, connected: false }] },
    })
    render(<RoomRoute roomId={roomId} />)
    expect(screen.getByText('Sam is reconnecting…')).toBeTruthy()
  })

  it('shows a banner while reconnecting', () => {
    show({ kind: 'reconnecting', attempt: 1 })
    expect(screen.getByText('Reconnecting…')).toBeTruthy()
  })

  it.each([
    ['room_full', 'This room is full'],
    ['not_found', 'Room not found'],
    ['replaced', "You're in this room in another tab"],
    ['rejected', "Couldn't join the room"],
  ] as const)('shows the %s page', (reason, title) => {
    show({ kind: 'closed', reason }, false)
    expect(screen.getByRole('heading').textContent).toBe(title)
  })

  it('"Use this tab instead" goes back to the lobby', () => {
    show({ kind: 'closed', reason: 'replaced' })
    fireEvent.click(screen.getByRole('button', { name: 'Use this tab instead' }))
    expect(screen.getByRole('button', { name: /Join|Rejoin/ })).toBeTruthy()
  })

  it('treats a session for another room as not joined', () => {
    useAppStore.setState({ roomId: 'AAAAAAAAAAAAAAAAAAAAAA', status: { kind: 'open' }, room })
    render(<RoomRoute roomId={roomId} />)
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy()
  })
})
```

`web/src/app/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { navigate } from './routes'

const roomId = 'Kx81mZq2Tq0Rb2_9sLm0Qa'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

describe('App', () => {
  it('creates a room from the landing page and lands in its lobby', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ roomId }), { status: 201 })))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))
    expect(await screen.findByRole('heading', { name: 'Join the watch party' })).toBeTruthy()
    expect(location.pathname).toBe(`/r/${roomId}`)
  })

  it('shows why creating a room failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }))
    expect((await screen.findByRole('alert')).textContent).toMatch('Too many rooms')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create room' }).disabled).toBe(false)
  })

  it('follows the Back button', () => {
    render(<App />)
    act(() => navigate(`/r/${roomId}`))
    expect(screen.getByRole('heading', { name: 'Join the watch party' })).toBeTruthy()
    act(() => {
      history.back()
    })
    return vi.waitFor(() => expect(screen.getByRole('button', { name: 'Create room' })).toBeTruthy())
  })

  it('shows Room not found for an unknown path', () => {
    history.replaceState(null, '', '/r/not-a-room')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Room not found' })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm --prefix web test -- src/app/RoomRoute.test.tsx src/app/App.test.tsx`
Expected: both files FAIL with `Error: Failed to resolve import` (`./RoomRoute` and `./App`).

- [ ] **Step 3: Write the stage component**

`web/src/stage/Stage.tsx`:

```tsx
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
```

- [ ] **Step 4: Write the pages**

`web/src/app/Landing.tsx`:

```tsx
import { useState } from 'react'
import { createRoom } from './api'
import { navigate, roomPath } from './routes'

export function Landing() {
  return (
    <main className="center-page">
      <div className="hero">
        <div className="hero-logo" aria-hidden="true">
          🍿
        </div>
        <h1>Popcorn for Two</h1>
        <p className="lede">Watch YouTube together, face to face, from anywhere.</p>
        <CreateRoomButton />
      </div>
    </main>
  )
}

export function CreateRoomButton() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    setError(null)
    try {
      navigate(roomPath(await createRoom()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="create-room">
      <button type="button" className="primary big" onClick={create} disabled={busy}>
        {busy ? 'Creating…' : 'Create room'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
```

`web/src/app/ErrorPage.tsx`:

```tsx
import type { ReactNode } from 'react'
import { CreateRoomButton } from './Landing'
import { resetSession } from './session'

export type ErrorKind = 'room_full' | 'not_found' | 'replaced' | 'rejected'

const pages: Record<ErrorKind, { title: string; body: string; action: () => ReactNode }> = {
  room_full: {
    title: 'This room is full',
    body: 'A room holds two people, and both seats are taken. Start a room of your own instead.',
    action: () => <CreateRoomButton />,
  },
  not_found: {
    title: 'Room not found',
    body: 'The link may be mistyped, or the room closed after 30 minutes with nobody in it.',
    action: () => <CreateRoomButton />,
  },
  replaced: {
    title: "You're in this room in another tab",
    body: 'The room is open in another tab or window, so this one stepped aside.',
    action: () => (
      <button type="button" className="primary" onClick={resetSession}>
        Use this tab instead
      </button>
    ),
  },
  rejected: {
    title: "Couldn't join the room",
    body: "The server didn't accept this tab's request to join. Going back to the lobby usually fixes it.",
    action: () => (
      <button type="button" className="primary" onClick={resetSession}>
        Back to the lobby
      </button>
    ),
  },
}

export function ErrorPage({ kind }: { kind: ErrorKind }) {
  const page = pages[kind]
  return (
    <main className="center-page">
      <div className="card message-card">
        <h1>{page.title}</h1>
        <p>{page.body}</p>
        {page.action()}
      </div>
    </main>
  )
}
```

`web/src/app/Toolbar.tsx`:

```tsx
import type { RoomState } from './roomState'
import { navigate } from './routes'
import { leaveRoom } from './session'

// The controls are laid out now; plans 3-5 bring them to life.
export function Toolbar({ room }: { room: RoomState }) {
  return (
    <footer className="toolbar">
      <div className="tool-group grow">
        <input className="url-input" placeholder="Paste a YouTube link" aria-label="YouTube link" disabled />
        <button type="button" disabled>
          Load
        </button>
      </div>
      <div className="tool-group">
        <button type="button" aria-label="Play" disabled>
          ▶
        </button>
        <input type="range" className="seek" aria-label="Seek" disabled />
        <span className="time">0:00 / 0:00</span>
      </div>
      <div className="tool-group">
        <input type="range" className="volume" aria-label="Volume" disabled />
        <button type="button" disabled>
          Mic
        </button>
        <button type="button" disabled>
          Camera
        </button>
      </div>
      <div className="tool-group" role="group" aria-label="Pen">
        <button type="button" aria-pressed="true" disabled>
          Off
        </button>
        <button type="button" aria-pressed="false" disabled>
          Fading
        </button>
        <button type="button" aria-pressed="false" disabled>
          Sticky
        </button>
        <button type="button" disabled>
          Clear
        </button>
      </div>
      <div className="tool-group">
        <Presence room={room} />
        <button
          type="button"
          className="danger"
          onClick={() => {
            leaveRoom()
            navigate('/')
          }}
        >
          Leave
        </button>
      </div>
    </footer>
  )
}

function Presence({ room }: { room: RoomState }) {
  return (
    <ul className="presence" aria-label="People in the room">
      {room.participants.map((p) => (
        <li key={p.id} className={p.connected ? '' : 'away'}>
          <span className="dot" style={{ background: p.color }} />
          {p.name}
          {p.id === room.you && ' (you)'}
        </li>
      ))}
    </ul>
  )
}
```

`web/src/app/RoomPage.tsx`:

```tsx
import { useState } from 'react'
import { Stage } from '../stage/Stage'
import type { RoomState } from './roomState'
import { useAppStore } from './store'
import { Toolbar } from './Toolbar'

export function RoomPage() {
  const status = useAppStore((s) => s.status)
  const room = useAppStore((s) => s.room)
  if (!room) return null
  return (
    <div className="room">
      <Stage>
        <div className="stage-empty">
          <span aria-hidden="true">🍿</span>
          <p>No video loaded</p>
        </div>
        <PartnerNotice room={room} />
      </Stage>
      {status.kind === 'reconnecting' && (
        <div className="banner" role="status">
          Reconnecting…
        </div>
      )}
      <Toolbar room={room} />
    </div>
  )
}

function PartnerNotice({ room }: { room: RoomState }) {
  const partner = room.participants.find((p) => p.id !== room.you)
  if (!partner) {
    return (
      <div className="notice" role="status">
        <p>Waiting for your partner. Send them this room's link.</p>
        <CopyLinkButton />
      </div>
    )
  }
  if (!partner.connected) {
    return (
      <div className="notice" role="status">
        <p>{partner.name} is reconnecting…</p>
      </div>
    )
  }
  return null
}

function CopyLinkButton() {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link:', location.href) // no clipboard access (e.g. plain http)
    }
  }
  return (
    <button type="button" className="primary" onClick={copy}>
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  )
}
```

`web/src/app/RoomRoute.tsx`:

```tsx
import { ErrorPage } from './ErrorPage'
import { Lobby } from './Lobby'
import { RoomPage } from './RoomPage'
import { useAppStore } from './store'

const IDLE = { kind: 'idle' } as const

/** Picks the lobby, the room or an error page for /r/<roomId>. */
export function RoomRoute({ roomId }: { roomId: string }) {
  const status = useAppStore((s) => (s.roomId === roomId ? s.status : IDLE))
  const hasRoom = useAppStore((s) => s.roomId === roomId && s.room !== null)
  switch (status.kind) {
    case 'idle':
      return <Lobby roomId={roomId} joining={false} />
    case 'connecting':
    case 'reconnecting':
    case 'open':
      // Until the first welcome, stay in the lobby with the button busy.
      return hasRoom ? <RoomPage /> : <Lobby roomId={roomId} joining />
    case 'closed':
      return status.reason === 'left' ? <Lobby roomId={roomId} joining={false} /> : <ErrorPage kind={status.reason} />
  }
}
```

`web/src/app/App.tsx`:

```tsx
import { useEffect } from 'react'
import { ErrorPage } from './ErrorPage'
import { Landing } from './Landing'
import { RoomRoute } from './RoomRoute'
import { useRoute } from './routes'
import { syncSessionWithRoute } from './session'

export function App() {
  const route = useRoute()
  useEffect(() => syncSessionWithRoute(route), [route])
  switch (route.page) {
    case 'landing':
      return <Landing />
    case 'room':
      return <RoomRoute roomId={route.roomId} />
    case 'unknown':
      return <ErrorPage kind="not_found" />
  }
}
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './app/styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 5: Write the styles**

The look is a dark home cinema with a butter-yellow accent. It uses system fonts only, so the page loads nothing from outside.

`web/src/app/styles.css`:

```css
:root {
  --bg: #0e0c10;
  --panel: #18151c;
  --panel-raised: #221e27;
  --line: #2f2a35;
  --text: #f5efe4;
  --muted: #a69fae;
  --accent: #f2b544; /* butter */
  --accent-text: #1c1305;
  --danger: #e4572e;
  --radius: 16px;
  --toolbar-height: 64px;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-display: ui-rounded, 'SF Pro Rounded', 'Nunito', var(--font);

  color-scheme: dark;
  font-family: var(--font);
  color: var(--text);
  background: var(--bg);
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  background:
    radial-gradient(ellipse 80% 50% at 50% -10%, rgba(242, 181, 68, 0.12), transparent 70%),
    var(--bg);
}

h1 {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 0.5rem;
}

button,
input {
  font: inherit;
  color: inherit;
}

button {
  border: 1px solid var(--line);
  background: var(--panel-raised);
  border-radius: 10px;
  padding: 0.5rem 0.9rem;
  cursor: pointer;
}

button:disabled,
input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
  font-weight: 650;
}

button.big {
  padding: 0.8rem 1.6rem;
  font-size: 1.05rem;
}

button.danger {
  border-color: rgba(228, 87, 46, 0.6);
  color: #ffb39c;
}

button.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  text-decoration: underline;
}

.center-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 2rem;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
}

.message-card {
  max-width: 30rem;
  text-align: center;
}

.message-card p {
  color: var(--muted);
  line-height: 1.5;
  margin: 0 0 1.5rem;
}

.error {
  color: #ffb39c;
  margin: 0.75rem 0 0;
}

/* Landing */

.hero {
  text-align: center;
}

.hero-logo {
  font-size: 4.5rem;
  filter: drop-shadow(0 10px 30px rgba(242, 181, 68, 0.35));
}

.hero h1 {
  font-size: clamp(2.2rem, 6vw, 3.6rem);
}

.lede {
  color: var(--muted);
  font-size: 1.15rem;
  margin: 0 0 2rem;
}

/* Lobby */

.lobby {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 2rem;
  width: min(60rem, 100%);
}

@media (max-width: 760px) {
  .lobby {
    grid-template-columns: 1fr;
  }
}

.preview-frame {
  aspect-ratio: 16 / 9;
  border-radius: 12px;
  overflow: hidden;
  background: #000;
}

.preview-status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  align-items: center;
  margin-top: 0.75rem;
  color: var(--muted);
  font-size: 0.9rem;
}

.video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.video.mirrored {
  transform: scaleX(-1);
}

.initial-tile {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-size: 4rem;
  font-weight: 700;
  color: rgba(0, 0, 0, 0.65);
}

.mic-meter {
  width: 8rem;
  height: 6px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}

.mic-meter-fill {
  height: 100%;
  background: var(--accent);
  transform-origin: left;
  transition: transform 60ms linear;
}

.lobby-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border: none;
  padding: 0;
  margin: 0;
}

.field > span,
.field > legend {
  color: var(--muted);
  font-size: 0.85rem;
  padding: 0;
  margin-bottom: 0.4rem;
}

.field input:not([type='radio']) {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 0.65rem 0.8rem;
}

.swatches {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.swatch {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  cursor: pointer;
  position: relative;
}

.swatch input {
  position: absolute;
  inset: 0;
  opacity: 0;
  margin: 0;
  cursor: pointer;
}

.swatch:has(input:checked) {
  box-shadow:
    0 0 0 3px var(--panel),
    0 0 0 5px var(--text);
}

.swatch:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 5px;
}

.tip {
  margin: 0;
  padding: 0.7rem 0.9rem;
  border-radius: 10px;
  background: rgba(242, 181, 68, 0.08);
  color: #f3d79f;
  font-size: 0.9rem;
  line-height: 1.4;
}

/* Room */

.room {
  height: 100%;
  display: grid;
  grid-template-rows: minmax(0, 1fr) var(--toolbar-height);
  position: relative;
}

.stage-area {
  position: relative;
  overflow: hidden;
  background: #000; /* the letterbox bars */
}

.stage {
  position: absolute;
  overflow: hidden;
  background: radial-gradient(ellipse at center, #1b1720, #0b0a0d);
}

.stage-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  color: var(--muted);
}

.stage-empty span {
  font-size: 3rem;
  opacity: 0.6;
}

.notice {
  position: absolute;
  top: 1.25rem;
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

.notice p {
  margin: 0;
}

.banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 0.5rem;
  text-align: center;
  background: var(--accent);
  color: var(--accent-text);
  font-weight: 650;
  z-index: 10;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 0 1rem;
  background: var(--panel);
  border-top: 1px solid var(--line);
  overflow-x: auto;
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}

.tool-group.grow {
  flex: 1 1 14rem;
  min-width: 12rem;
}

.url-input {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 0.5rem 0.7rem;
}

.seek {
  width: 10rem;
}

.volume {
  width: 5rem;
}

.time {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  font-size: 0.9rem;
}

.presence {
  display: flex;
  gap: 0.8rem;
  list-style: none;
  margin: 0 0.5rem 0 0;
  padding: 0;
  font-size: 0.9rem;
}

.presence li {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.presence li.away {
  opacity: 0.5;
}

.dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
}
```

- [ ] **Step 6: Run them to verify they pass**

Run: `npm --prefix web test -- src/app/RoomRoute.test.tsx src/app/App.test.tsx`
Expected: `Tests  15 passed (15)`.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm --prefix web test && npm --prefix web run typecheck`
Expected: `Test Files  13 passed | 1 skipped (14)` and `Tests  157 passed | 6 skipped (163)`, then no typecheck output.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(web): landing, room page with letterboxed stage, toolbar shell and error pages"
```

---

### Task 12: Build into the Go binary, verify the dev proxy, record decisions

**Files:**
- Create: `web/scripts/embed.mjs`
- Modify: `docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md` (section 13, **Client**)

**Interfaces:**
- Consumes: the whole app; `server/internal/webdist` (plan 1), which embeds `dist/` with `//go:embed all:dist`.
- Produces: `npm --prefix web run embed`. It typechecks, builds, and copies `web/dist/*` into `server/internal/webdist/dist/`, after removing everything there except `.gitkeep`.

- [ ] **Step 1: Write the embed script**

`web/scripts/embed.mjs`:

```js
// Copies the built frontend (web/dist) into the Go server's embed directory,
// replacing whatever was there except the tracked .gitkeep placeholder.
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const target = fileURLToPath(new URL('../../server/internal/webdist/dist/', import.meta.url))

if (!existsSync(`${dist}index.html`)) {
  console.error('web/dist/index.html is missing. Run the build first.')
  process.exit(1)
}
for (const name of readdirSync(target)) {
  if (name !== '.gitkeep') rmSync(`${target}${name}`, { recursive: true, force: true })
}
cpSync(dist, target, { recursive: true })
console.log(`Copied web/dist into server/internal/webdist/dist`)
```

- [ ] **Step 2: Build and embed**

```bash
echo stale > server/internal/webdist/dist/stale.txt
npm --prefix web run embed
ls -A server/internal/webdist/dist server/internal/webdist/dist/assets
git status --short server/internal/webdist
```

Expected:
- `vite v8.3.2 building client environment for production...` and `✓ built in …`
- `Copied web/dist into server/internal/webdist/dist`
- The directory lists `.gitkeep`, `assets` and `index.html`, and `stale.txt` is gone. `assets/` holds one `index-<hash>.js` (about 336 kB, about 102 kB gzipped) and one `index-<hash>.css`.
- `git status` shows nothing under `server/internal/webdist`, because the build output is gitignored.

- [ ] **Step 3: Confirm the Go binary serves the app**

```bash
GOTOOLCHAIN=local go -C server build -o bin/popcorn ./cmd/server
PORT=8099 server/bin/popcorn &
SERVER_PID=$!
sleep 1
curl -s localhost:8099/ | grep -o '<div id="root"></div>'
curl -s localhost:8099/r/Kx81mZq2Tq0Rb2_9sLm0Qa | grep -o '<title>Popcorn for Two</title>'
JS=$(basename server/internal/webdist/dist/assets/*.js)
curl -s -o /dev/null -D - localhost:8099/assets/$JS | grep -iE '^HTTP|^cache-control'
curl -s -o /dev/null -w '%{http_code}\n' localhost:8099/assets/missing.js
kill $SERVER_PID
```

Expected:
- `<div id="root"></div>`
- `<title>Popcorn for Two</title>`, which comes from the SPA fallback
- `HTTP/1.1 200 OK` and `Cache-Control: public, max-age=31536000, immutable`
- `404`

- [ ] **Step 4: Confirm the dev proxy passes the WebSocket Origin check**

```bash
server/bin/popcorn &
GO_PID=$!
npm --prefix web run dev -- --port 5173 --strictPort &
VITE_PID=$!
sleep 4
ROOM=$(curl -s -X POST localhost:5173/api/rooms | sed 's/.*"roomId":"\([^"]*\)".*/\1/')
echo "room=$ROOM"
upgrade() { curl -s -i --max-time 2 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $1" "http://localhost:5173/ws?room=$ROOM" | head -1; }
echo "same origin:  $(upgrade http://localhost:5173)"
echo "other origin: $(upgrade http://evil.example)"
kill $VITE_PID $GO_PID
```

Expected:
- `room=<22 characters>`. The `/api` proxy works.
- `same origin:  HTTP/1.1 101 Switching Protocols`. The proxy kept the browser's `Host`, so `Origin` matches it.
- `other origin: HTTP/1.1 403 Forbidden`. The server's check is active.
- Vite may print `ws proxy error: Error: write EPIPE`. That's `curl --max-time` hanging up on the open socket, and it's harmless.

If the first upgrade gets 403, someone has added `changeOrigin: true` to the `/ws` proxy. Remove it.

- [ ] **Step 5: Manual check in two browser windows**

With the Go server and `npm --prefix web run dev` running, open `http://localhost:5173` in Chrome.

1. **Create room** goes to `/r/<id>`. The lobby asks for the camera and mic, shows your mirrored preview and a moving mic meter, shows the headphones tip, and **Join** is disabled until you type a name.
2. Join. The room page shows a letterboxed 16:9 stage that keeps its shape as you resize the window, "Waiting for your partner…" with **Copy link**, and the toolbar.
3. Open the copied link in a second window (another profile or a private window), using a different name and color, and join. The first window's notice disappears, and both toolbars list both people.
4. Reload the second window. Its lobby says **Welcome back**, with the name and color filled in and a **Rejoin** button. Click Rejoin and it's back in the room. While it was gone, the first window showed "<name> is reconnecting…".
5. Stop the Go server. Both windows show **Reconnecting…**. Start it again within a few seconds. The room is gone, because state lived in memory, so both windows end on **Room not found**. That's correct for a restart.
6. In a fresh room with both people joined, open the room URL in a third window and click Join. It shows **This room is full**.
7. Duplicate a joined tab (Tab → Duplicate). The duplicate takes the seat, and the original shows "You're in this room in another tab" and stays there without reconnecting.
8. Click **Leave**. You're back on the landing page, and the camera light turns off.

- [ ] **Step 6: Record the decisions in the spec**

In `docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md`, section 13, add these bullets at the end of the **Client (for later plans)** list:

```markdown
- **Liveness (plan 2):** besides the clock rounds, the client sends a heartbeat `ping` every 10 seconds. If nothing arrives within 5 seconds of a ping, or no `welcome` arrives within 10 seconds of opening a socket, it drops the socket and reconnects. Without this a half-open socket could outlast the 30-second grace period.
- **Leaving the page (plan 2):** going from a room back to the landing page inside the app (the **Leave** button, or Back when the previous page is the app's own) sends `leave` and turns the camera off. Any other way of leaving the page (closing the tab, typing a URL, Back out of the site) holds the seat for the 30-second grace period, like a dropped connection. A `pagehide` handler can't send `leave`, because a reload must keep the seat.
- **Another tab took over (plan 2):** close code 4001 shows "You're in this room in another tab" with **Use this tab instead**, which goes back to the lobby; **Rejoin** then takes the seat back.
- **Unknown rooms (plan 2):** there's no room-lookup endpoint, so a stale link shows the lobby first and "Room not found" after **Join**.
- **Test tooling (plan 2):** Vitest 4 and jsdom 29, because Vitest 5 and jsdom 30 don't support Node 25. Vitest workers run with `--no-experimental-webstorage`, because Node 25's own `localStorage` hides jsdom's.
```

- [ ] **Step 7: Run everything one last time**

```bash
npm --prefix web test
npm --prefix web run typecheck
GOTOOLCHAIN=local go -C server test -race ./...
```

Expected: `Tests  157 passed | 6 skipped (163)`, no typecheck output, and `ok` for the `httpapi`, `protocol`, `room` and `turn` Go packages.

- [ ] **Step 8: Commit**

```bash
git add web/scripts docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md
git commit -m "build(web): embed the built app in the Go server; record plan 2 decisions in spec"
```
