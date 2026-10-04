# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Popcorn for Two: two people in a room watch a YouTube video in sync while on a WebRTC video call, with their cams, cursors and ink on a shared 16:9 stage. A Go server holds the authoritative room state in memory (no database); a Vite + React + TypeScript frontend is embedded into the Go binary.

The design spec, [docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md](docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md), is the source of truth for behavior, protocol, limits and close codes. Section 13 records decisions made during planning that override or refine earlier sections. Implementation plans are in `docs/superpowers/plans/`. The spec's build order (section 12) has six steps: 1 (Go server), 2 (frontend shell) and 3 (synced YouTube playback) are done. The spec describes `web/src/call/`, `ink/`, `cursors/` and `e2e/`, but they don't exist yet.

## Commands

Run everything from the repo root.

```sh
# Go (always with -race; local Go 1.25.5, so prefix with GOTOOLCHAIN=local if Go tries to download a toolchain)
go -C server test -race ./...
go -C server test -race ./internal/room/ -run 'TestName'
gofmt -l server                       # must print nothing
go -C server run ./cmd/server         # :8080 (PORT, TURN_PROVIDER=cloudflare, TURN_KEY_ID, TURN_API_TOKEN)

# Web (npm runs inside web/, so test paths are relative to web/)
npm --prefix web test
npm --prefix web test -- src/app/session.test.ts
npm --prefix web run typecheck
npm --prefix web run dev              # Vite proxies /api and /ws to the Go server on :8080
npm --prefix web run embed            # build, then copy web/dist into server/internal/webdist/dist/

# RoomClient contract test against a real server (skipped unless POPCORN_SERVER is set)
POPCORN_SERVER=http://localhost:8099 npm --prefix web test -- src/net/client.server.test.ts
```

The Go binary serves whatever is in `server/internal/webdist/dist/`. That folder is gitignored except for `.gitkeep`, so run `embed` before running the server on its own.

## Architecture

**Server (`server/`, module `popcorn`)**
- `internal/room`: each room is **one hub goroutine that owns its state**. Connections, timers and ticks all become `Event`s on the hub's channel, so there are no locks. All room logic is the pure, deterministic reducer `Apply(state, event, now) (state, []Outbound)` in `reducer.go`. Randomness (new IDs, tokens) and ICE servers are passed in on the event, so tests drive `Apply` with a fake clock. The hub only runs `Apply` and delivers the `Outbound`s. A `Conn` never blocks: if its queue fills up, it's closed. `Registry` is the only mutex-guarded map, and hubs remove themselves when their room expires.
- `internal/protocol`: hand-written message structs. `DecodeClient` validates and clamps every incoming message, and any failure wraps `ErrBadMessage`. `Encode` puts `type` first.
- `internal/httpapi`: `POST /api/rooms`, `GET /ws?room=` (WebSocket via `github.com/coder/websocket`), and the SPA fallback. Rejections are sent in-band as an `error` message followed by a close code, because browsers can't read the status of a failed upgrade.
- `internal/turn`: Cloudflare TURN credentials, cached and refreshed. Without config, the server falls back to STUN only.

**Protocol contract.** Message types are written by hand twice: Go structs in `server/internal/protocol` and zod schemas in `web/src/protocol/schemas.ts` (the TS types are inferred from the schemas). `protocol-fixtures/{client,server}/<type>.json` holds exactly one fixture per message type. Both test suites load every fixture: Go round-trips it through its struct, and TS checks that `schema.parse` leaves it unchanged. **To change a message, update the Go struct, the zod schema and the fixture together.** Client schemas enforce the server's limits, while server-message schemas check shape only.

**Web (`web/src/`)**
- Ownership rules:
  - Only `net/` opens WebSockets (`RoomClient` handles the handshake, backoff, close codes, clock offset and heartbeat).
  - Only `app/session.ts` writes the Zustand store (`app/store.ts`).
  - Room state changes only through `applyServerMessage` in `app/roomState.ts`.
  - `player/` never imports `app/`. `player/store.ts` holds local player facts that never go over the wire (duration, error, autoplayBlocked, volume). Only `PlaybackSync` and `setMovieVolume` write it.
  - Gestures in progress (dragging a cam, drawing) live in the components doing them, not in the store.
- Nobody applies their own playback command locally. Both clients apply only the server's broadcast state.
- **Playback (`player/`):**
  - `PlaybackSync` (`sync.ts`) drives a `Player` from `room.playback`: it applies the state, corrects drift, reports stalls and recovers when the room waits for this browser. It sends only `playback.stalled` and `playback.ready`; the toolbar (`app/PlaybackControls.tsx`) sends the commands.
  - `app/PlayerLayer.tsx` mounts the player as stage layer 1 and feeds `PlaybackSync` from `useAppStore.subscribe`.
  - `YouTubePlayer` hand-types the IFrame API (there's no `@types` package). `load()` cues and doesn't play.
  - `FakePlayer` is driven by a clock (`Date.now`, so fake timers move it) and copies YouTube's quirks: seeking a cued or ended video starts it, `play()` after the end restarts at 0, and the duration is 0 until the video first plays.
- **Real YouTube is asynchronous:** commands are postMessages and reads are cached.
  - `getCurrentTime()` keeps the pre-seek value until the iframe's next report, and while the player reports Playing it estimates up to 1 s ahead.
  - Test stall and recovery logic with `FakePlayer`'s `estimateAhead` option and a lagging subclass (see `sync.test.ts`), not only with the default fake.
- `RoomClient` sets the status to `open` before the welcome's message listeners run, so store subscribers briefly see "connected" with the pre-drop room.
- Stage positions are always **fractions (0–1) of the stage**, never pixels (see `stage/geometry.ts`).
- Resume tokens are kept per room in `localStorage` (`popcorn.resume.<roomId>`), so every tab in a browser is the same person. The reasons are in spec section 13.
- Routing is a few lines of history handling in `app/routes.ts`, with no router library.

## Conventions

- Don't change Go dependencies (`golang.org/x/time` stays at v0.15.0). npm dependencies use exact versions (`--save-exact`). Don't add a router, UI kit or CSS framework. Vitest 4 and jsdom 29 are pinned because newer versions skip Node 25. Vitest runs with `--no-experimental-webstorage` because Node 25's own `localStorage` hides jsdom's.
- TypeScript has `strict` and `erasableSyntaxOnly` on: no enums or parameter properties, so use `as const` objects. App code doesn't see Node types; only test files do, through `tsconfig.test.json`.
- Commit messages are Conventional Commits with a scope: `feat(server): …`, `fix(web): …`, `test(web): …`, `docs: …`.
- When behavior changes in a way the spec doesn't describe, record it in spec section 13 (as the earlier plans did).
- **Tests:**
  - Component tests that only need a fixed clock use `vi.useFakeTimers({ toFake: ['Date'] })`, so React and testing-library keep real timers.
  - To get a clock offset of exactly 0, answer pings with `FakeSocket.onSend` (see `app/Toolbar.test.tsx`).
  - Vitest's jsdom doesn't fetch external scripts, so a real `YouTubePlayer` mounted in tests stays inert.
- Keep this file current: refresh it with the claude-md-management skill after each plan.
