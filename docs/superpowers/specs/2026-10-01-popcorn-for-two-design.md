# Popcorn for Two — Design Spec

**Date:** 2026-10-01
**Status:** Reviewed; amended during planning (2026-10-01, see section 13)

## 1. Purpose

A web app where a long-distance couple watches a YouTube video together while on a video call. The two facecams sit on a **shared stage** over the video: either person can drag and resize them, see the other's cursor, and draw on the screen.

**Who it's for:** primarily the author and their partner (personal use), and secondarily a portfolio/learning project. That means:
- No public sign-up, matchmaking, billing, or multi-tenant concerns. A shareable room link is the only "account."
- The core experience should feel polished, and the code should be clean and well-tested enough to show off.
- The backend is written in **Go** partly as a learning goal, so it has a real role (authoritative room state), not just a relay.

## 2. Success criteria

1. Two people on **different networks** can create and join a room from a link, see and hear each other, and load a YouTube video.
2. Playback stays within **~1 second** between the two browsers, including after seeks, buffering, and ads.
3. Moving or resizing a cam, drawing a stroke, or moving the cursor shows up on the partner's screen within roughly **200ms** under normal conditions.
4. A browser that disconnects and reconnects within 30 seconds is restored to the full room state (video, position, cam layout, sticky ink).
5. Go unit and integration tests, frontend unit tests, and the two-browser end-to-end test all pass.

## 3. Scope

### In scope (v1)
- Rooms of exactly two people, joined by an unguessable link.
- Peer-to-peer video and audio call (WebRTC) with TURN fallback.
- Synced YouTube playback (load, play, pause, seek) with drift correction and auto-pause for buffering, ads, and disconnects.
- A shared stage: draggable and resizable cams, live cursors, fading ink and sticky ink.
- Desktop browsers (Chrome, Firefox, Safari, Edge; latest versions).

### Out of scope (possible later work)
- Local video files (both people having the file with synced playback, or one person streaming it).
- Games.
- Accounts, saved rooms, watch history.
- Mobile layout.
- Lowering movie volume while someone talks.
- More than two people per room.
- Streaming services with DRM (Netflix etc.).

## 4. Architecture

```
Browser A ◄──── WebRTC (cams + mic, P2P, TURN fallback) ────► Browser B
    │                                                           │
    └──────── WebSocket ────────► Go server ◄──── WebSocket ────┘
                                (rooms + state)
     The YouTube player runs in each browser; only commands are synced.
```

- **Audio and video** go directly between the browsers over WebRTC. If a direct connection isn't possible, they go through a hosted TURN relay (Cloudflare or Metered free tier).
- **All other shared state** (playback, cam layout, cursors, ink, presence, WebRTC signaling) goes through the Go server over one WebSocket per browser. The server is the **single source of truth** for room state.
- **No database.** All room state is in memory.

### 4.1 Repository layout

```
/
  server/                      Go module
    cmd/server/main.go         entry point: config, HTTP server, embedded frontend
    internal/protocol/         message structs + JSON encoding
    internal/room/             room state, pure reducer, hub goroutine, registry
    internal/httpapi/          HTTP handlers: create room, WebSocket upgrade
    internal/turn/             fetches short-lived TURN credentials
  web/                         Vite + React + TypeScript
    src/protocol/              message types (mirror of Go structs)
    src/net/                   WebSocket client
    src/call/                  WebRTC
    src/player/                YouTube player wrapper + fake for tests
    src/stage/                 stage layout, cams, coordinate helpers
    src/ink/                   drawing canvas
    src/cursors/               remote cursor rendering
    src/app/                   pages (landing, lobby, room), store, toolbar
  protocol-fixtures/           example JSON messages both test suites validate
  e2e/                         Playwright tests
  docs/
```

### 4.2 Backend (Go)

- **HTTP endpoints**
  - `POST /api/rooms`: creates a room and returns `201 { roomId }`. The room ID is 128 random bits, base64url-encoded (22 characters). If 1,000 rooms already exist it returns 503.
  - `GET /ws?room=<id>`: upgrades to a WebSocket. Rejections are sent **in-band**, because browsers can't read the HTTP status of a failed upgrade: unknown room → `error not_found` then close code 4404; a `hello` when both seats are taken (including a seat held for reconnection) → `error room_full` then close code 4409.
  - `GET /*`: serves the built React app, embedded in the binary with `embed.FS`, with SPA fallback to `index.html`.
- **WebSocket library:** `github.com/coder/websocket`.
- **Room hub:** each room is **one goroutine that owns the room's state**. Connections send events to it on a channel. Nothing else reads or writes the state, so no locks are needed. Each connection has its own writer goroutine with a buffered outbound queue. A connection whose queue fills up is closed, so one slow client can't stall the room.
- **Pure reducer:** the room logic lives in a pure function:
  ```go
  func Apply(state RoomState, ev Event, now time.Time) (RoomState, []Outbound)
  ```
  The hub goroutine only receives events, calls `Apply`, and sends the resulting outbound messages. Timers (grace-period expiry, room expiry) arrive as events too, so all logic is testable with a fake clock.
- **Registry:** a map from room ID to hub, guarded by a mutex. It creates hubs and removes them when they expire.
- **Room lifecycle:** a room expires **30 minutes** after it becomes empty. A room that's created but never joined expires after 30 minutes too.
- **TURN credentials:** on each join, the server requests short-lived ICE server credentials from the TURN provider's API and includes them in the `welcome` message. The provider API key exists only on the server.
- **Config (env vars):** `PORT`, `TURN_PROVIDER`, `TURN_KEY_ID`, `TURN_API_TOKEN`. If TURN isn't configured, the server falls back to a public STUN server only and logs a warning.

### 4.3 Frontend (React + TypeScript)

- **Build:** Vite. In development, the Vite dev server proxies `/api` and `/ws` to the Go server on `:8080`.
- **State:** a single Zustand store holds the client's copy of room state, and only the server's messages change it. One exception: things you're actively doing (dragging your cam, drawing a stroke) render locally straight away, without waiting for the server.
- **Modules (one job each):**
  - `net/`: typed WebSocket client. It handles the `hello`/`welcome` handshake, reconnects with exponential backoff (0.5s, 1s, 2s, 4s, capped at 8s), and measures the clock offset. It's the only code that talks to the server.
  - `call/`: `getUserMedia` (with echo cancellation and noise suppression on), the `RTCPeerConnection` using the **perfect negotiation** pattern, ICE restarts, and the remote stream.
  - `player/`: the interface `Player { load(videoId, startSeconds?); play(); pause(); seek(seconds); setVolume(volume); getCurrentTime(); getDuration(); getState(); onStateChange(cb); onError(cb); onAutoplayBlocked(cb); destroy() }`. `load` cues a video without playing it. `YouTubePlayer` implements it using the IFrame API. `FakePlayer` is a test double, driven by a clock, used by unit and end-to-end tests. `PlaybackSync` drives a `Player` from the room's playback state (section 13).
  - `stage/`: the stage container plus coordinate helpers (`toFraction`, `toPixels`). It also handles cam tiles and drag/resize, using hand-written pointer-event code. Positions are stored as fractions, which a pixel-based library like react-rnd would fight against.
  - `ink/`: two canvases (sticky and fading), stroke rendering, fade animation, draw-mode handling.
  - `cursors/`: renders the partner's cursor with their name and color, and smooths its movement between updates.
  - `app/`: pages (landing, lobby, room), the toolbar, and wiring.

## 5. The stage

- The stage is the **largest 16:9 rectangle** that fits the window above the toolbar, centered with letterbox bars.
- All positions are **fractions of the stage** (0–1 on each axis), so layouts line up across different screen sizes.
- **Layers, bottom to top:**
  1. YouTube player (`controls=0`, `pointer-events: none`; the app provides its own controls)
  2. Cam tiles
  3. Sticky-ink canvas
  4. Fading-ink canvas
  5. Remote cursor
- **Draw mode:**
  - **Off** (the default): the ink canvases ignore the pointer, so cams can be dragged and resized.
  - **On**: the ink canvases capture the pointer and drawing uses the selected pen (fading or sticky).
  - Pressing `D` toggles draw mode, keeping the last pen used.
  - Cursor tracking works in both modes, because it listens on the stage container.
- **Cams**
  - The cam ID equals the participant ID.
  - Default positions: the first participant bottom-left and the second bottom-right, each 22% of the stage width.
  - Each cam keeps its camera's aspect ratio and is resized from its corners.
  - Minimum width is 8% of the stage, and a cam is always kept fully inside the stage.
  - Your own cam is shown **mirrored** on your screen only (selfie convention). Your partner sees it unmirrored.
  - If a camera is off or permission was denied, the tile shows the person's initial on their color.
- **Toolbar** (below the stage):
  - YouTube URL input and a **Load** button
  - Play/pause and a seek bar with time
  - Local volume (not synced)
  - Mic mute and camera on/off
  - Pen selector (off / fading / sticky) and **Clear** (removes all sticky ink)
  - **Leave**

## 6. Protocol

All messages are JSON with the shape `{ "type": string, ...fields }`. Coordinates are fractions of the stage, times are in seconds (playback) or Unix milliseconds (clock). The server checks every incoming message (section 9.2).

### 6.1 Client → server

| type | fields | notes |
|---|---|---|
| `hello` | `name`, `color`, `pageSession`, `resumeToken?` | Must be the first message. `pageSession` is a random ID generated once per page load. `resumeToken` reclaims a held spot (section 9.1). |
| `ping` | `t0` | For measuring the clock offset. |
| `playback.load` | `videoId` | |
| `playback.play` | `position` | |
| `playback.pause` | `position` | |
| `playback.seek` | `position` | |
| `playback.stalled` | — | The local player isn't advancing while the room is playing (section 7.3). |
| `playback.ready` | — | The local player is buffered and paused at the room position. |
| `cam.grab` | `camId` | |
| `cam.move` | `camId`, `rect {x,y,w,h}` | Ignored unless the sender holds the cam. |
| `cam.release` | `camId`, `rect` | The final position when the pointer is released. |
| `cursor` | `x`, `y` | Throttled to ~30 Hz. |
| `cursor.hide` | — | The pointer left the stage. |
| `ink.points` | `strokeId`, `mode`, `color`, `width`, `points [[x,y],…]` | Batched about every 33ms, at most 64 points per batch. |
| `ink.end` | `strokeId` | |
| `ink.clear` | — | Clears all sticky strokes. |
| `signal` | `data` | A WebRTC description or ICE candidate. The server passes it through without reading it. |
| `leave` | — | The **Leave** button. The seat is freed immediately (no 30-second hold) and the server closes the connection with code 1000. |

### 6.2 Server → client

| type | fields | notes |
|---|---|---|
| `welcome` | `you`, `resumeToken`, `polite`, `iceServers`, `snapshot` | Reply to `hello`. `polite` assigns the perfect-negotiation role: someone joining an empty room is impolite, and someone joining an occupied room takes the opposite role to the person already there (so the two roles always differ, even after seats turn over). The role stays with the participant ID across resumes. |
| `pong` | `t0`, `serverTime` | |
| `participant.joined` | `participant {id,name,color,pageSession}` | Sent on a first join and on every resume. |
| `participant.reconnecting` | `id` | Their connection dropped and their spot is being held. |
| `participant.left` | `id` | The grace period expired, or they left on purpose. |
| `playback` | `state` | The full playback state (section 7.1) after any change. |
| `cam` | `camId`, `rect`, `holder` | `holder` is a participant ID or `null`. |
| `cursor` | `from`, `x`, `y` | Passed along, not stored. |
| `cursor.hide` | `from` | |
| `ink.points` | `from`, `strokeId`, `mode`, `color`, `width`, `points` | |
| `ink.end` | `from`, `strokeId` | |
| `ink.clear` | `from` | |
| `signal` | `from`, `data` | |
| `error` | `code`, `message` | Codes: `bad_message`, `rate_limited`, `room_full`, `not_found`. |

### 6.3 Snapshot

```
snapshot = {
  participants: [{ id, name, color, pageSession, connected }],
  playback: PlaybackState,
  cams: { [camId]: { rect, holder } },
  stickyStrokes: [{ id, author, color, width, points }]
}
```

### 6.4 Keeping Go and TypeScript in sync

The message types are written by hand in both `server/internal/protocol` and `web/src/protocol`. `protocol-fixtures/` holds one example JSON file per message type. The Go tests decode each fixture into its struct and re-encode it, checking nothing is lost. The TypeScript tests check each fixture against its type with a runtime validator (zod schemas, which also generate the TS types). If the format changes on one side only, a test fails.

## 7. Playback sync

### 7.1 State

```
PlaybackState = {
  videoId: string | null,
  playing: boolean,
  position: number,        // seconds, as of updatedAt
  updatedAt: number,       // server Unix ms
  waitingFor: string | null,  // participant id we auto-paused for
  autoResume: boolean
}
```

The expected position at server time `now` is `position + (playing ? (now − updatedAt)/1000 : 0)`.

### 7.2 Commands

- When someone sends `play`, `pause` or `seek`, the server sets `position` and `updatedAt = now`, sets `playing` to match the command, clears `waitingFor`/`autoResume`, and broadcasts `playback`.
- `load` sets the new `videoId`, `position = 0`, `playing = false`.
- Both browsers, including the sender, apply only the broadcast state. Nobody acts on their own command before the server confirms it. The delay this adds when you press play is about one round trip to the server, which is acceptable.

### 7.3 Clock offset, drift and stalls

- **Clock offset:**
  - On connect, the client sends 5 pings, picks the one with the shortest round-trip time, and computes `offset = serverTime − (t0 + rtt/2)`.
  - It repeats this every 30 seconds. Server "now" is then `Date.now() + offset`.
- **Drift check:**
  - Every 2 seconds, while the room is playing and the player isn't within 3 seconds of a seek or load, the client compares the player's `getCurrentTime()` with the expected position.
  - If they differ by more than **1.0 second**, it seeks to the expected position. It doesn't try speeding playback up or down, because YouTube only offers coarse speed steps.
- **Stall detection:**
  - If the room is playing and the local player hasn't advanced for more than **2 seconds**, the client sends `playback.stalled`. That covers buffering and ads, which the IFrame API doesn't report directly.
  - The server then auto-pauses: `playing = false`, `position = expected now`, `waitingFor = sender`, `autoResume = true`. The UI shows "Waiting for {name}…".
- **Recovery:**
  - The stalled client waits until its player is playable again (for example, the ad has ended), pauses and seeks to `position`, then sends `playback.ready`.
  - If `autoResume` is set and the sender is the person being waited for, the server resumes: `playing = true`, `updatedAt = now`, `waitingFor = null`.
- **Manual override:** any manual `play`, `pause` or `seek` clears the waiting state.
- **After a reconnect:** if the snapshot's `waitingFor` is the client's own ID, it loads the video and lets it play until the video itself moves (so any ad is over), then pauses, seeks to `position`, and sends `playback.ready` once the player is paused there. That's what lets a partner who dropped out auto-resume (section 9.4). The same steps follow the client's own stall.

### 7.4 YouTube errors

- The URL input accepts `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/` and `youtube.com/embed/` links, plus bare 11-character IDs.
- If the input can't be parsed, the error shows locally and nothing is sent.
- If the player reports error 2, 5, 100, 101 or 150 (invalid, not found, or embedding disabled), the client shows "This video can't be played here." The video is already loaded in the room at that point, so the person who loaded it can load another one.

## 8. Layout, cursors and ink

### 8.1 Cams (last grab wins)

- `cam.grab` sets `holder` to the person grabbing, taking it from the other person if they were holding it. The server broadcasts `cam`.
- `cam.move` from anyone other than the holder is ignored.
- The server clamps every rectangle so it stays inside the stage and meets the minimum size, then broadcasts it.
- `cam.release` applies the final rectangle and clears `holder`.
- If the holder disconnects, `holder` is cleared.
- **What the person dragging sees:** local rendering follows their pointer straight away. Incoming `cam` updates for that cam are ignored while they're dragging it, unless the update shows a different holder. In that case, their drag ends (they've been overridden).

### 8.2 Cursors

- The client sends its position at about 30 Hz while the pointer is over the stage, and `cursor.hide` when it leaves.
- The server passes cursor messages along without storing them.
- The partner's browser smooths the movement between updates (about 80ms behind live) and fades the cursor out after 3 seconds without movement.

### 8.3 Ink

- **While drawing**, the client sends points in batches about every 33ms and shows the stroke locally straight away. Lifting the pen sends `ink.end`.
- **Stroke limits:** each person has their own color, and stroke width is fixed at 0.004 of the stage width. A stroke is capped at 2,000 points; after that the client ends it and starts a new one automatically.
- **Fading strokes:**
  - The server passes them along and doesn't store them.
  - On both screens, a fading stroke stays fully visible while it's being drawn, then fades out over **3 seconds** after `ink.end`.
  - A stroke that never gets `ink.end` (for example, because the sender disconnected) starts fading 1 second after its last batch.
- **Sticky strokes:**
  - The server adds the points to `stickyStrokes` and passes them along.
  - If there are more than **500** sticky strokes, the oldest are dropped.
  - `ink.clear` empties the list and is broadcast to both people.

## 9. Call, joining and error handling

### 9.1 Joining and reconnecting

1. **Landing page:** the **Create room** button sends `POST /api/rooms` and goes to `/r/<roomId>`.
2. **Lobby:**
   - Asks for a name and a color (from a preset palette). These are remembered in `localStorage`.
   - Shows a camera and mic preview, with the permission prompt.
   - Shows a "Headphones recommended" tip.
   - Has a **Join** button.
3. **Join:** the client opens the WebSocket, sends `hello`, and receives `welcome`. It stores the `resumeToken` in `localStorage`, one per room, so every tab in the same browser resumes as the same person (section 13).
4. **Reconnecting:**
   - When a connection drops, the server marks the person disconnected and holds their spot for **30 seconds**, broadcasting `participant.reconnecting`.
   - If a `hello` comes back with a valid `resumeToken` in that time, the person gets the same participant ID back and the full snapshot.
   - After 30 seconds without one, the server broadcasts `participant.left` and frees the spot.
5. **Room full:** a third person's `hello` gets `error room_full` and close code 4409, and the client shows a "This room is full" page.
6. **Stale connection:** a `hello` with a valid `resumeToken` for a participant the server still thinks is connected (for example, a half-open TCP connection after Wi-Fi dropped) takes over the seat. The old connection is closed with code 4001.

### 9.2 Server validation and limits

- **Size limits:** messages over 16 KB close the connection, and `ink.points` batches over 64 points are rejected.
- **Bad messages:** unknown `type`s or wrong field types get an `error bad_message` reply, and the message is dropped. The connection stays open.
- **Rate limiting:** each connection has a token bucket of 100 messages per second, with bursts up to 200. Messages over the limit are dropped, with an `error rate_limited` sent at most once per second.
- **Clamping:** all coordinates are clamped to [0,1], and playback positions to ≥ 0.
- **Video IDs:** `videoId` must match `^[A-Za-z0-9_-]{11}$`.
- **Signaling:** `signal` messages are passed along only when both people are connected.

### 9.3 Video call

- **Perfect negotiation:** each person's role comes from `welcome.polite`, and `signal` messages carry the WebRTC handshake (descriptions and ICE candidates).
- **When to rebuild the connection:** each client remembers the partner's `pageSession`. When `participant.joined` arrives with a **different** `pageSession` (the partner reloaded or opened a new tab), the client closes its `RTCPeerConnection` and starts a fresh one. When it's the **same** `pageSession` (only the partner's WebSocket dropped), the existing call is kept.
- **Connection drops:**
  - If the connection state becomes `failed`, the impolite peer restarts the connection (an ICE restart).
  - If it hasn't reconnected within 15 seconds, the remote tile shows "Video lost" with a **Retry** button, which rebuilds the peer connection.
  - Watching, ink and cursors keep working throughout, because they don't depend on the call.
- **Echo:** browser echo cancellation is on, but it probably won't remove YouTube audio coming out of the speakers. That's why the lobby recommends headphones. Mic mute is always available.

### 9.4 Failure table

| Situation | Behavior |
|---|---|
| Camera or mic permission denied | Join anyway. The tile shows the person's initial, with a "Retry camera" button. |
| WebSocket drops | "Reconnecting…" banner, then backoff retries, then a resume with the full snapshot. |
| Partner disconnects | Playback auto-pauses with `waitingFor` = the partner. If they resume within 30 seconds and send `ready`, playback auto-resumes. If the grace period expires, the room stays paused and `waitingFor` is cleared. |
| WebRTC fails | ICE restart. After 15 seconds, "Video lost" and a Retry button. |
| Bad URL or video that can't be embedded | Inline message. The room is otherwise unaffected. |
| Unknown room ID | "Room not found" page with a **Create room** button. |

## 10. Testing

- **Go unit tests** (`internal/room`) call `Apply` with a fake clock and cover:
  - the expected-position math
  - play, pause, seek and load
  - the stall, auto-pause and ready-to-resume sequence
  - a manual override clearing the waiting state
  - grab takeover and rejecting moves from non-holders
  - rectangle clamping
  - the sticky-ink cap and clearing it
  - room full
  - the resume token within the grace period, and the grace period expiring
  - room expiry
- **Go integration test:** an `httptest` server with two real WebSocket clients. Both join, one sends commands, and the test checks that both receive identical broadcasts. It also covers reconnecting with a resume token.
- **Protocol fixtures:** both test suites check every file in `protocol-fixtures/` (section 6.4).
- **Frontend unit tests (Vitest):**
  - YouTube URL parsing
  - the clock offset calculation
  - expected position and the drift decision
  - `toFraction`/`toPixels`
  - fade timing for ink
  - cursor smoothing
- **End-to-end (Playwright):**
  - Two browser contexts with Chrome's fake camera flags (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`). The app runs with `FakePlayer` enabled (`?player=fake`, which only works in development builds).
  - Checks: both join and see two cam tiles, a cam drag in A moves the cam in B, a stroke in A appears in B, a cursor in A appears in B, and play/pause in A changes the state in B.
- **Manual check before release:** a real call between two different networks (for example, one person on a phone hotspot), confirming video connects through TURN when needed and playback stays in sync through a YouTube ad.

## 11. Deployment

- A single Fly.io app runs the Go binary, with the built frontend embedded in it. A Dockerfile uses a multi-stage build: Node builds `web/`, then Go builds `server/` with the static files embedded.
- WebSockets work over Fly's standard HTTPS. A single machine is enough, since rooms are in memory and there are only two users.
- TURN uses a hosted free tier. Credentials are set as Fly secrets.

## 12. Build order

1. Go server: rooms, WebSocket, `hello`/`welcome`, snapshot, reconnect, plus the protocol fixtures.
2. Frontend shell: landing page, lobby, `net/` client, room page with the stage.
3. Synced YouTube playback (`player/`, clock offset, drift, stalls).
4. WebRTC call plus cam tiles on the stage with drag and resize.
5. Cursors and ink.
6. Polish, error states, end-to-end tests, deployment.

## 13. Decisions made during planning

These fill gaps found when the spec was reviewed for implementation. Where they touch an earlier section, that section has been updated too.

**Server**
- **Stale connections:** a resume with a valid token replaces a connection the server still thinks is alive (section 9.1, step 6). The server also pings every connection every 15 seconds, so a dead connection is noticed promptly and the 30-second grace period starts on time.
- **Leaving on purpose:** a new `leave` message (section 6.1). If the leaver was the person playback was waiting for, `waitingFor` is cleared and the room stays paused.
- **Perfect-negotiation roles:** a newcomer takes the role the other person doesn't hold (section 6.2). Default cam positions follow the role: impolite bottom-left, polite bottom-right.
- **Cam rectangles:** the server doesn't know a camera's aspect ratio. It clamps rectangles while keeping their own width-to-height ratio. The default rectangle assumes a 16:9 camera (`h = w` in stage fractions, because the stage is also 16:9). The client sets `h` from the real aspect ratio when the person resizes. Tiles use `object-fit: cover`.
- **Holder checks:** `cam.release` from someone who isn't the holder is ignored, just like `cam.move`.
- **Playback commands:** `seek` keeps `playing` unchanged. `play`, `pause`, `seek`, `stalled` and `ready` are ignored while no video is loaded. A partner disconnecting only auto-pauses if the room was playing.
- **Ink:** the server overwrites `color` with the sender's participant color and `width` with 0.004, so the client can't change them. Besides the 500-stroke cap, sticky ink is capped at **100,000 points in total**, with the oldest strokes dropped first. This keeps `welcome` small (500 strokes × 2,000 points would be about 15 MB of JSON). The server drops points beyond 2,000 in a single stroke. Ink coordinates are rounded to 4 decimals (still finer than a pixel at 4K), which keeps a full sticky board's `welcome` around 1.6 MB. The client should round the same way, and should trim sticky strokes exactly as the server does (oldest first, at 500 strokes or 100,000 points), because the server doesn't announce which strokes it dropped.
- **Validation details:** `hello.name` is trimmed and must be 1–32 characters. `color` must be `#rrggbb`. IDs and tokens are at most 64 characters. Binary frames get `bad_message`. If the first message isn't a valid `hello`, the server sends `error bad_message` and closes with code 4400. If no `hello` arrives within 10 seconds, the connection is closed.
- **Close codes:** 1000 left, 4001 replaced by a newer connection, 4400 bad first message, 4404 room not found, 4409 room full.
- **TURN:** only Cloudflare is implemented (`TURN_PROVIDER=cloudflare`). Credentials are requested with a 12-hour TTL, cached server-wide, and refreshed once half the TTL has passed. If a fetch fails, `welcome` carries STUN only and the server logs a warning.
- **Embedding:** Go's `embed` can't reach `../web/dist`, so the build copies the frontend into `server/internal/webdist/dist/`.

**Client (for later plans)**
- **Message rate:** `cam.move` is throttled to about 30 Hz, like cursors. Cursor, cam and ink traffic together then stay under the 100 messages per second limit.
- **End of video:** when the player reports "ended", or the expected position is past the video's duration, the client doesn't send `playback.stalled` and the drift check clamps to the duration. Otherwise the end of a video would loop through stall, pause and resume.
- **Reloading:** after a reload, the person goes back through the lobby. Their name and color are filled in, and they press **Rejoin**. The click counts as a user gesture, so the browser allows autoplay with sound and the camera starts again.
- **Liveness (plan 2):** besides the clock rounds, the client sends a heartbeat `ping` every 10 seconds. If nothing arrives within 5 seconds of a ping, or no `welcome` arrives within 10 seconds of opening a socket, it drops the socket and reconnects. Without this a half-open socket could outlast the 30-second grace period.
- **Leaving the page (plan 2):** going from a room back to the landing page inside the app (the **Leave** button, or Back when the previous page is the app's own) sends `leave` and turns the camera off. Any other way of leaving the page (closing the tab, typing a URL, Back out of the site) holds the seat for the 30-second grace period, like a dropped connection. A `pagehide` handler can't send `leave`, because a reload must keep the seat.
- **Another tab took over (plan 2):** close code 4001 shows "You're in this room in another tab" with **Use this tab instead**, which goes back to the lobby; **Rejoin** then takes the seat back.
- **Resume token in `localStorage` (plan 2 fix):** the token is kept per room in `localStorage` (`popcorn.resume.<roomId>`), not `sessionStorage`, so every tab in one browser counts as the same person. With `sessionStorage`, two things went wrong:
  - Safari's Duplicate Tab doesn't copy `sessionStorage` (Chrome and Edge do), so a duplicated tab joined as a new person. It took the partner's free seat, or got "room full".
  - Closing the tab and reopening the link within 30 seconds got "room full", because a new tab never had the token.

  Now a duplicated tab, a new tab or a reopened link shows "Welcome back" with **Rejoin**. Rejoining takes over the seat, and the old tab shows "You're in this room in another tab". **Leave** still removes the token, and the room-full page keeps **Try again** for a private window that was closed and reopened. The trade-off: two people can't share one browser profile in a room. A normal window and a private window are still two people, but two Chrome Incognito windows share storage and count as one. When the server says a room doesn't exist (close code 4404), the client deletes that room's token, so an expired room's link says "Welcome back" at most once. Tokens for expired rooms that are never reopened stay in `localStorage`. They're tiny and never shown.
- **Unknown rooms (plan 2):** there's no room-lookup endpoint, so a stale link shows the lobby first and "Room not found" after **Join**.
- **Test tooling (plan 2):** Vitest 4 and jsdom 29, because Vitest 5 and jsdom 30 don't support Node 25. Vitest workers run with `--no-experimental-webstorage`, because Node 25's own `localStorage` hides jsdom's.

**Client (plan 3)**
- **Player interface:** `load(videoId, startSeconds?)` cues without playing. Besides the calls in section 4.3, the interface has `setVolume`, `getState`, `onError`, `onAutoplayBlocked` and `destroy`. `getDuration()` is 0 until the video's metadata loads. The IFrame API is typed by hand, so there's no `@types` package.
- **Getting ready when the room waits for you:**
  - This applies after the client's own stall, and after a reconnect or reload.
  - The player plays until the video itself has really moved, so an ad or buffering is over: the player reports Playing and its time has gone more than 1.5 s past where recovery began. YouTube's `getCurrentTime()` estimates up to 1 s ahead of the player's last report while it says Playing, even when the video is stuck behind an ad, so the reading creeps ahead and snaps back. Progress is therefore measured past a high-water mark, reset on every apply, cue and seek. A step counts for no more than the time since the last reading (ticks are 250 ms apart), and a step more than 2 s beyond that is a jump (a cued start arriving late, say), which moves the mark without counting. The mark also comes down, without counting, when a reading falls more than 1.5 s below it. YouTube's `seekTo` is only a message to its iframe, so right after the client's own seek the reading is still the old time, and a seek back would otherwise leave the mark above the video and report a false stall.
  - The same progress measure drives stall reports, so a stuck player whose reading creeps ahead still stalls, up to 1 s later than the 2 s rule alone would say.
  - Then it pauses, seeks to `position`, and sends `playback.ready` once the player is paused within 0.5 s of it. "Cued" and "Ended" count as paused, so a room waiting past the end still recovers.
  - Cueing and seeking can't avoid playing, because YouTube starts a cued video when it's seeked. The person being waited for may hear a fraction of a second of audio.
  - If the player has already ended, or the room's position is past the end, the client doesn't play, because that would start the video over. It pauses at the position and says ready. The "past the end" check needs the duration, so it applies only once the duration is known. After a reload the duration is 0, so the client cues at the position and plays. How YouTube handles a start past the end is unverified.
  - The same goes for a playing room: a player that has ended is never told to play, even if the room's expected position is still just short of the end.
  - If the player reaches the end before the room's position, the client seeks back to the position and then says ready.
  - If the player reports an error while the room waits for it, the client sends `playback.ready` at once, so an unplayable video never holds the partner.
- **While the WebSocket is down:** the local player pauses, and no `stalled` or `ready` is sent. After the next `welcome`, the snapshot is applied as new. The connection status turns open just before the welcome arrives, so the client doesn't apply the stale pre-drop state then: it waits for the welcome's new playback state.
- **Small sync rules:**
  - A paused player more than 0.25 s from the room position is seeked. One that is cued, unstarted or ended is cued again at the position instead, because seeking it would start it.
  - If YouTube starts playing while the room is paused, the client pauses it again.
  - Drift checks skip a player that isn't reporting "playing".
  - A player error stops stall reports.
- **Blocked autoplay:** when YouTube reports `onAutoplayBlocked`, the stage shows "Your browser blocked the video. Click the video to start it." with **Start video** as a second way in, and the video itself becomes clickable until it plays. The prompt points at the video because Safari may not count a click on our page as a user gesture inside YouTube's cross-origin iframe. Until then the stall rule makes the room wait for that person.
- **Clickable while the room waits for you:** the video also takes clicks while the room's `waitingFor` is you, so YouTube's Skip ad button works and an ad doesn't hold the partner for its whole length. Otherwise, apart from blocked autoplay, the player layer and its iframe ignore the pointer (section 5).
- **A player that never loads:** if the YouTube player can't be created, or doesn't become ready within 15 s (YouTube's second script blocked, or the iframe replaced by a privacy extension), the client shows the "didn't load" message, the same as a failed IFrame API script. The error rule (no stall reports, and `ready` at once while the room waits) keeps the room from being held.
- **Controls:**
  - Play and Pause send the room's expected position, clamped to the duration. Play at or past the end sends 0.
  - The seek bar shows the room's time and sends one `playback.seek` on the input's native `change` event, which fires once when a drag ends and once per key step. Dragging only moves the bar. If the connection drops mid-drag, the drag is dropped and never sent.
  - The time display uses `serverNow()`, not the local player.
  - The volume slider sets this browser's YouTube volume only, and isn't saved.
- **Notices:**
  - "Waiting for {name}…" when the room is waiting for the partner, and "Waiting for your video to catch up…" when it's waiting for you. "{name} is reconnecting…" replaces the waiting notice while the partner is away.
  - YouTube errors 2, 5, 100, 101 and 150 show "This video can't be played here."
  - A failed IFrame API script shows its own message, and other error codes show the number.
- **Player facts:** the video's duration, a player error, blocked autoplay and the volume live in `player/store.ts`, apart from the room store, because they never go over the wire. Only `PlaybackSync` and the volume slider write them.
- **FakePlayer** copies YouTube's quirks the sync logic depends on: a cued video doesn't play until told to; seeking a cued, unstarted or ended video starts it; `play()` after the end starts over; the duration is 0 until the video first plays; and the end is reported as an `Ended` state change as soon as any command or state read catches up with the clock. With `estimateAhead`, it reads the time the way YouTube's widget does while playing: its last report plus the time since, up to 1 s.
- **Known trade-off:** the server auto-pauses a stall at the expected position, about 2 seconds past where the stalled player froze, so that person skips those seconds. Fixing it would need a `position` on `playback.stalled`.
