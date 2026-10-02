# Popcorn for Two, Plan 1: Go Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested Go server that creates rooms and runs one authoritative hub goroutine per room over WebSockets. It implements every server-side rule in the spec: joining, reconnecting, playback sync, cams, cursors, ink, signaling, limits and TURN credentials.

**Architecture:** All room logic is one pure, deterministic function, `room.Apply(state, event, now) (state, []Outbound)`. A hub goroutine per room owns the state. It feeds events into `Apply`, encodes the outbound messages and queues them on each connection without ever blocking. `httpapi` turns WebSocket connections into hub calls, using one reader, one writer and one pinger goroutine per connection. `protocol` holds the message structs, and `protocol-fixtures/` pins their JSON shape for both the Go and TypeScript test suites.

**Tech Stack:** Go 1.25 (`net/http`, `log/slog`, `embed`), `github.com/coder/websocket` v1.8.15, `golang.org/x/time/rate` v0.15.0. Tests use the standard library `testing` package only and run with `-race`.

**Spec:** `docs/superpowers/specs/2026-10-01-popcorn-for-two-design.md`. Sections 4.2, 6, 7, 8, 9 and **13** (decisions made during planning) govern this plan.

## Plan series

This is plan 1 of 6. The plans follow the spec's build order (section 12), and each one ends with working, tested software:

1. **Go server** (this plan)
2. **Frontend shell:**
   - Vite + React + TypeScript scaffold
   - zod protocol schemas, tested against `protocol-fixtures/`
   - `net/` client: handshake, backoff, clock offset
   - Zustand store
   - Landing, lobby and room pages, with stage geometry
   - Dev proxy, and a build step that copies the frontend into `server/internal/webdist/dist/`
3. Synced YouTube playback
4. WebRTC call and cam tiles
5. Cursors and ink
6. Polish, error states, Playwright end-to-end tests, Dockerfile and Fly.io deployment

Each later plan is written after the one before it has merged, so it can use the real names and types.

## Global Constraints

- The Go module is at `server/` with module path `popcorn`. The `go` directive is whatever `go mod init` writes with the local 1.25 toolchain. Don't add a dependency version that needs a newer Go: for example, `golang.org/x/time` v0.16.0 needs Go 1.26, so pin **v0.15.0**.
- The only third-party dependencies are `github.com/coder/websocket v1.8.15` and `golang.org/x/time v0.15.0`. Tests use the standard library `testing` package only (no testify).
- Run every command from the repo root. Go commands take the form `go -C server …`, and tests always run with `-race`.
- There's no database. All state is in memory.
- **Rooms:**
  - Room ID: 128 random bits, base64url-encoded (22 characters).
  - At most 2 participants per room.
  - Grace period after a disconnect: 30 s.
  - A room expires 30 min after it becomes empty, or 30 min after creation if nobody joins.
  - At most 1,000 rooms at once.
- **Messages:** JSON in the form `{ "type": …, …fields }`. The shapes and camelCase field names match spec section 6 exactly, plus `leave`.
- **Limits:**
  - 16 KB per message (larger messages close the connection with code 1009).
  - At most 64 points per ink batch.
  - 100 messages per second per connection, with bursts up to 200. `rate_limited` is sent at most once per second.
  - Coordinates are clamped to [0,1] and positions to ≥ 0.
  - `videoId` must match `^[A-Za-z0-9_-]{11}$`.
  - Names are 1–32 characters after trimming. Colors are `#rrggbb`. IDs and tokens are at most 64 characters.
- **Stage:**
  - Cams: minimum width 0.08, default width 0.22.
  - Ink: width 0.004. A stroke holds at most 2,000 points. Sticky ink holds at most 500 strokes and 100,000 points.
- **Close codes:** 1000 left, 4001 replaced, 4400 bad first message, 4404 not found, 4409 room full.
- **Environment variables:** `PORT` (default 8080), `TURN_PROVIDER` (`cloudflare`), `TURN_KEY_ID`, `TURN_API_TOKEN`.

## Review Focus

1. **Reconnecting while the server still thinks the old socket is alive** (a half-open TCP connection after Wi-Fi drops). The person must get their own seat back, never "room full". Tested by Task 4 `TestResumeReplacesStaleConnection` and Task 10 `TestReconnectReplacesStaleConnection`.
2. **A stranger arriving while a seat is held for a reconnecting partner.** The stranger gets `room_full`, and the partner can still resume. Tested by Task 4 `TestRoomFullWhileSeatIsHeld`.
3. **Seats turning over** (the first person leaves and someone new joins). The two perfect-negotiation roles must still differ, or the WebRTC call can deadlock. Tested by Task 4 `TestNewcomerTakesTheFreeRole`.
4. **A browser whose connection stops draining.** It's dropped without stalling the room, and the partner sees "reconnecting". Tested by Task 7 `TestHubDropsSlowConnection`.
5. **An evening of sticky drawing.** `welcome` must stay small enough to send. Tested by Task 6 `TestStickyPointCapKeepsWelcomeSmall`.

---

## File Structure

```
protocol-fixtures/
  client/<type>.json          one example per client → server message (18 files)
  server/<type>.json          one example per server → client message (14 files)
server/
  go.mod                      module popcorn
  cmd/server/main.go          config from env, HTTP server, graceful shutdown
  internal/protocol/
    types.go                  shared structs (Rect, PlaybackState, Snapshot, …) and constants
    messages.go               one struct per message type, MsgType(), decoder registries
    codec.go                  Encode, DecodeClient, DecodeServer
    validate.go               required fields, clamping, ID/color/videoId rules
  internal/room/
    ids.go                    room IDs, participant IDs, resume tokens
    state.go                  RoomState, Participant, ExpectedPosition, ClampCamRect, Snapshot
    reducer.go                Apply, events, Outbound, joining/resume/leave/expiry
    playback.go               play/pause/seek/load, stall → auto-pause → ready
    stage.go                  cams (last grab wins), cursors, ink, signal relay
    hub.go                    Conn interface, Hub goroutine
    registry.go               room ID → Hub, room cap
  internal/turn/turn.go       Provider, Static (STUN), Cloudflare (cached credentials)
  internal/httpapi/
    server.go                 routes, POST /api/rooms
    static.go                 embedded SPA with index.html fallback
    ws.go                     GET /ws: hello, read loop, rate limit, writer, pinger
  internal/webdist/
    webdist.go                //go:embed all:dist
    dist/.gitkeep             the built frontend is copied here (plan 2)
.gitignore
```

---

### Task 1: Go module, protocol messages and fixtures

**Files:**
- Create: `server/go.mod` (via `go mod init`)
- Create: `protocol-fixtures/client/*.json` (18 files), `protocol-fixtures/server/*.json` (14 files)
- Create: `server/internal/protocol/types.go`, `server/internal/protocol/messages.go`, `server/internal/protocol/codec.go`
- Test: `server/internal/protocol/codec_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces (package `popcorn/internal/protocol`):
  - **Interfaces:** `Message` (`MsgType() string`) and `ClientMsg` (a `Message` that the browser sends).
  - **Client message structs:** `Hello`, `Ping`, `PlaybackLoad`, `PlaybackPlay`, `PlaybackPause`, `PlaybackSeek`, `PlaybackStalled`, `PlaybackReady`, `CamGrab`, `CamMove`, `CamRelease`, `Cursor`, `CursorHide`, `InkPoints`, `InkEnd`, `InkClear`, `Signal`, `Leave`.
  - **Server message structs:** `Welcome`, `Pong`, `ParticipantJoined`, `ParticipantReconnecting`, `ParticipantLeft`, `PlaybackUpdate` (type `playback`), `CamUpdate` (type `cam`), `CursorRelay`, `CursorHideRelay`, `InkPointsRelay`, `InkEndRelay`, `InkClearRelay`, `SignalRelay`, `ErrorMsg`.
  - **Shared types:** `Rect`, `Point`, `Participant`, `SnapshotParticipant`, `PlaybackState`, `CamState`, `Stroke`, `Snapshot`, `IceServer`.
  - **Functions:**
    - `Encode(Message) ([]byte, error)`
    - `DecodeClient([]byte) (ClientMsg, error)`
    - `DecodeServer([]byte) (Message, error)`
    - `ClientTypes() []string`, `ServerTypes() []string`
    - `Ptr[T](T) *T`
  - **Error and constants:** `ErrBadMessage`; `Code*`, `Close*` and `InkFading`/`InkSticky`.

- [ ] **Step 1: Create the Go module**

```bash
mkdir -p server
go -C server mod init popcorn
```

Expected: `go: creating new go.mod: module popcorn`.

- [ ] **Step 2: Write the protocol fixtures**

These are the contract shared with the TypeScript side. Each file is one complete, valid message whose values are already normalized (clamped, trimmed), so decoding and re-encoding it must give back the same JSON.

```bash
mkdir -p protocol-fixtures/client protocol-fixtures/server
cat > protocol-fixtures/client/cam.grab.json <<'EOF'
{"type":"cam.grab","camId":"Kx81mZq2Tq0"}
EOF
cat > protocol-fixtures/client/cam.move.json <<'EOF'
{"type":"cam.move","camId":"Kx81mZq2Tq0","rect":{"x":0.1,"y":0.6,"w":0.22,"h":0.22}}
EOF
cat > protocol-fixtures/client/cam.release.json <<'EOF'
{"type":"cam.release","camId":"Kx81mZq2Tq0","rect":{"x":0.12,"y":0.58,"w":0.25,"h":0.25}}
EOF
cat > protocol-fixtures/client/cursor.hide.json <<'EOF'
{"type":"cursor.hide"}
EOF
cat > protocol-fixtures/client/cursor.json <<'EOF'
{"type":"cursor","x":0.5,"y":0.25}
EOF
cat > protocol-fixtures/client/hello.json <<'EOF'
{"type":"hello","name":"Alex","color":"#e4572e","pageSession":"ps-7f3a9c2e","resumeToken":"3q2m8xKzP1vB7nLw4cRt0g"}
EOF
cat > protocol-fixtures/client/ink.clear.json <<'EOF'
{"type":"ink.clear"}
EOF
cat > protocol-fixtures/client/ink.end.json <<'EOF'
{"type":"ink.end","strokeId":"s1"}
EOF
cat > protocol-fixtures/client/ink.points.json <<'EOF'
{"type":"ink.points","strokeId":"s1","mode":"sticky","color":"#e4572e","width":0.004,"points":[[0.1,0.2],[0.11,0.21],[0.125,0.23]]}
EOF
cat > protocol-fixtures/client/leave.json <<'EOF'
{"type":"leave"}
EOF
cat > protocol-fixtures/client/ping.json <<'EOF'
{"type":"ping","t0":1790000000000}
EOF
cat > protocol-fixtures/client/playback.load.json <<'EOF'
{"type":"playback.load","videoId":"dQw4w9WgXcQ"}
EOF
cat > protocol-fixtures/client/playback.pause.json <<'EOF'
{"type":"playback.pause","position":42.5}
EOF
cat > protocol-fixtures/client/playback.play.json <<'EOF'
{"type":"playback.play","position":42.5}
EOF
cat > protocol-fixtures/client/playback.ready.json <<'EOF'
{"type":"playback.ready"}
EOF
cat > protocol-fixtures/client/playback.seek.json <<'EOF'
{"type":"playback.seek","position":120}
EOF
cat > protocol-fixtures/client/playback.stalled.json <<'EOF'
{"type":"playback.stalled"}
EOF
cat > protocol-fixtures/client/signal.json <<'EOF'
{"type":"signal","data":{"description":{"type":"offer","sdp":"v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\n"}}}
EOF
cat > protocol-fixtures/server/cam.json <<'EOF'
{"type":"cam","camId":"Kx81mZq2Tq0","rect":{"x":0.1,"y":0.6,"w":0.22,"h":0.22},"holder":"Rb2_9sLm0Qa"}
EOF
cat > protocol-fixtures/server/cursor.hide.json <<'EOF'
{"type":"cursor.hide","from":"Rb2_9sLm0Qa"}
EOF
cat > protocol-fixtures/server/cursor.json <<'EOF'
{"type":"cursor","from":"Rb2_9sLm0Qa","x":0.5,"y":0.25}
EOF
cat > protocol-fixtures/server/error.json <<'EOF'
{"type":"error","code":"room_full","message":"This room already has two people."}
EOF
cat > protocol-fixtures/server/ink.clear.json <<'EOF'
{"type":"ink.clear","from":"Rb2_9sLm0Qa"}
EOF
cat > protocol-fixtures/server/ink.end.json <<'EOF'
{"type":"ink.end","from":"Rb2_9sLm0Qa","strokeId":"s7"}
EOF
cat > protocol-fixtures/server/ink.points.json <<'EOF'
{"type":"ink.points","from":"Rb2_9sLm0Qa","strokeId":"s7","mode":"fading","color":"#2e86ab","width":0.004,"points":[[0.4,0.4],[0.41,0.42]]}
EOF
cat > protocol-fixtures/server/participant.joined.json <<'EOF'
{"type":"participant.joined","participant":{"id":"Rb2_9sLm0Qa","name":"Sam","color":"#2e86ab","pageSession":"ps-c41d0788"}}
EOF
cat > protocol-fixtures/server/participant.left.json <<'EOF'
{"type":"participant.left","id":"Rb2_9sLm0Qa"}
EOF
cat > protocol-fixtures/server/participant.reconnecting.json <<'EOF'
{"type":"participant.reconnecting","id":"Rb2_9sLm0Qa"}
EOF
cat > protocol-fixtures/server/playback.json <<'EOF'
{"type":"playback","state":{"videoId":"dQw4w9WgXcQ","playing":false,"position":61.2,"updatedAt":1790000003000,"waitingFor":"Rb2_9sLm0Qa","autoResume":true}}
EOF
cat > protocol-fixtures/server/pong.json <<'EOF'
{"type":"pong","t0":1790000000000,"serverTime":1790000000042}
EOF
cat > protocol-fixtures/server/signal.json <<'EOF'
{"type":"signal","from":"Rb2_9sLm0Qa","data":{"candidate":{"candidate":"candidate:1 1 udp 2122260223 192.168.1.2 54400 typ host","sdpMid":"0","sdpMLineIndex":0}}}
EOF
cat > protocol-fixtures/server/welcome.json <<'EOF'
{"type":"welcome","you":"Kx81mZq2Tq0","resumeToken":"3q2m8xKzP1vB7nLw4cRt0g","polite":false,"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"user-1","credential":"secret-1"}],"snapshot":{"participants":[{"id":"Kx81mZq2Tq0","name":"Alex","color":"#e4572e","pageSession":"ps-7f3a9c2e","connected":true},{"id":"Rb2_9sLm0Qa","name":"Sam","color":"#2e86ab","pageSession":"ps-c41d0788","connected":false}],"playback":{"videoId":"dQw4w9WgXcQ","playing":true,"position":42.5,"updatedAt":1790000000000,"waitingFor":null,"autoResume":false},"cams":{"Kx81mZq2Tq0":{"rect":{"x":0.02,"y":0.745,"w":0.22,"h":0.22},"holder":null},"Rb2_9sLm0Qa":{"rect":{"x":0.76,"y":0.745,"w":0.22,"h":0.22},"holder":"Kx81mZq2Tq0"}},"stickyStrokes":[{"id":"s1","author":"Kx81mZq2Tq0","color":"#e4572e","width":0.004,"points":[[0.1,0.2],[0.11,0.21]]}]}}
EOF
```

- [ ] **Step 3: Write the failing fixture test**

`server/internal/protocol/codec_test.go`:

```go
package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const fixturesDir = "../../../protocol-fixtures"

func readFixture(t *testing.T, dir, typ string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixturesDir, dir, typ+".json"))
	if err != nil {
		t.Fatalf("missing fixture %s/%s.json: %v", dir, typ, err)
	}
	return data
}

func assertSameJSON(t *testing.T, want, got []byte) {
	t.Helper()
	var w, g any
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("encoded message is not JSON: %v", err)
	}
	if !reflect.DeepEqual(w, g) {
		t.Errorf("round trip changed the message\nfixture: %s\nencoded: %s", want, got)
	}
}

func TestClientFixturesRoundTrip(t *testing.T) {
	for _, typ := range ClientTypes() {
		t.Run(typ, func(t *testing.T) {
			raw := readFixture(t, "client", typ)
			m, err := DecodeClient(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if m.MsgType() != typ {
				t.Fatalf("decoded as %q", m.MsgType())
			}
			out, err := Encode(m)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			assertSameJSON(t, raw, out)
		})
	}
}

func TestServerFixturesRoundTrip(t *testing.T) {
	for _, typ := range ServerTypes() {
		t.Run(typ, func(t *testing.T) {
			raw := readFixture(t, "server", typ)
			m, err := DecodeServer(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := Encode(m)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			assertSameJSON(t, raw, out)
		})
	}
}

func TestEveryFixtureMatchesAType(t *testing.T) {
	for dir, types := range map[string][]string{"client": ClientTypes(), "server": ServerTypes()} {
		entries, err := os.ReadDir(filepath.Join(fixturesDir, dir))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			typ := strings.TrimSuffix(e.Name(), ".json")
			if !slices.Contains(types, typ) {
				t.Errorf("%s/%s has no matching message type", dir, e.Name())
			}
		}
	}
}

func TestEncodePutsTypeFirst(t *testing.T) {
	cases := map[string]Message{
		`{"type":"playback.stalled"}`:            PlaybackStalled{},
		`{"type":"participant.left","id":"abc"}`: ParticipantLeft{ID: "abc"},
	}
	for want, m := range cases {
		got, err := Encode(m)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Errorf("Encode(%T) = %s, want %s", m, got, want)
		}
	}
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `go -C server test -race ./internal/protocol/`
Expected: FAIL to compile with `undefined: ClientTypes`, `undefined: DecodeClient`, and similar errors.

- [ ] **Step 5: Write the shared types**

`server/internal/protocol/types.go`:

```go
// Package protocol defines the JSON messages that travel over the WebSocket
// between the browser and the server. web/src/protocol mirrors these types by
// hand; the files in protocol-fixtures/ keep the two sides in sync.
package protocol

// Rect is a cam tile's position and size, as fractions of the stage.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Point is an [x, y] pair, as fractions of the stage.
type Point [2]float64

type Participant struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	PageSession string `json:"pageSession"`
}

type SnapshotParticipant struct {
	Participant
	Connected bool `json:"connected"`
}

type PlaybackState struct {
	VideoID    *string `json:"videoId"`
	Playing    bool    `json:"playing"`
	Position   float64 `json:"position"`  // seconds, as of UpdatedAt
	UpdatedAt  int64   `json:"updatedAt"` // server Unix milliseconds
	WaitingFor *string `json:"waitingFor"`
	AutoResume bool    `json:"autoResume"`
}

type CamState struct {
	Rect   Rect    `json:"rect"`
	Holder *string `json:"holder"`
}

type Stroke struct {
	ID     string  `json:"id"`
	Author string  `json:"author"`
	Color  string  `json:"color"`
	Width  float64 `json:"width"`
	Points []Point `json:"points"`
}

type Snapshot struct {
	Participants  []SnapshotParticipant `json:"participants"`
	Playback      PlaybackState         `json:"playback"`
	Cams          map[string]CamState   `json:"cams"`
	StickyStrokes []Stroke              `json:"stickyStrokes"`
}

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Ink modes.
const (
	InkFading = "fading"
	InkSticky = "sticky"
)

// Codes sent in ErrorMsg.Code.
const (
	CodeBadMessage  = "bad_message"
	CodeRateLimited = "rate_limited"
	CodeRoomFull    = "room_full"
	CodeNotFound    = "not_found"
)

// WebSocket close codes. RFC 6455 reserves 4000-4999 for applications.
const (
	CloseNormal     = 1000 // the participant left on purpose
	CloseReplaced   = 4001 // the same participant connected again elsewhere
	CloseBadMessage = 4400 // the first message wasn't a valid hello
	CloseNotFound   = 4404
	CloseRoomFull   = 4409
)

// Ptr returns a pointer to v, for the nullable fields.
func Ptr[T any](v T) *T { return &v }
```

- [ ] **Step 6: Write the message structs and registries**

`server/internal/protocol/messages.go`:

```go
package protocol

import (
	"encoding/json"
	"maps"
	"slices"
)

// Message is anything that travels over the WebSocket. MsgType is the value
// of its "type" field.
type Message interface {
	MsgType() string
}

// ClientMsg is a message the browser sends.
type ClientMsg interface {
	Message
	isClientMsg()
}

// ---- Client → server ----

type Hello struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	PageSession string `json:"pageSession"`
	ResumeToken string `json:"resumeToken,omitempty"`
}

type Ping struct {
	T0 float64 `json:"t0"`
}

type PlaybackLoad struct {
	VideoID string `json:"videoId"`
}

type PlaybackPlay struct {
	Position float64 `json:"position"`
}

type PlaybackPause struct {
	Position float64 `json:"position"`
}

type PlaybackSeek struct {
	Position float64 `json:"position"`
}

type PlaybackStalled struct{}

type PlaybackReady struct{}

type CamGrab struct {
	CamID string `json:"camId"`
}

type CamMove struct {
	CamID string `json:"camId"`
	Rect  Rect   `json:"rect"`
}

type CamRelease struct {
	CamID string `json:"camId"`
	Rect  Rect   `json:"rect"`
}

type Cursor struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type CursorHide struct{}

type InkPoints struct {
	StrokeID string  `json:"strokeId"`
	Mode     string  `json:"mode"`
	Color    string  `json:"color"`
	Width    float64 `json:"width"`
	Points   []Point `json:"points"`
}

type InkEnd struct {
	StrokeID string `json:"strokeId"`
}

type InkClear struct{}

type Signal struct {
	Data json.RawMessage `json:"data"`
}

type Leave struct{}

func (Hello) MsgType() string           { return "hello" }
func (Ping) MsgType() string            { return "ping" }
func (PlaybackLoad) MsgType() string    { return "playback.load" }
func (PlaybackPlay) MsgType() string    { return "playback.play" }
func (PlaybackPause) MsgType() string   { return "playback.pause" }
func (PlaybackSeek) MsgType() string    { return "playback.seek" }
func (PlaybackStalled) MsgType() string { return "playback.stalled" }
func (PlaybackReady) MsgType() string   { return "playback.ready" }
func (CamGrab) MsgType() string         { return "cam.grab" }
func (CamMove) MsgType() string         { return "cam.move" }
func (CamRelease) MsgType() string      { return "cam.release" }
func (Cursor) MsgType() string          { return "cursor" }
func (CursorHide) MsgType() string      { return "cursor.hide" }
func (InkPoints) MsgType() string       { return "ink.points" }
func (InkEnd) MsgType() string          { return "ink.end" }
func (InkClear) MsgType() string        { return "ink.clear" }
func (Signal) MsgType() string          { return "signal" }
func (Leave) MsgType() string           { return "leave" }

func (Hello) isClientMsg()           {}
func (Ping) isClientMsg()            {}
func (PlaybackLoad) isClientMsg()    {}
func (PlaybackPlay) isClientMsg()    {}
func (PlaybackPause) isClientMsg()   {}
func (PlaybackSeek) isClientMsg()    {}
func (PlaybackStalled) isClientMsg() {}
func (PlaybackReady) isClientMsg()   {}
func (CamGrab) isClientMsg()         {}
func (CamMove) isClientMsg()         {}
func (CamRelease) isClientMsg()      {}
func (Cursor) isClientMsg()          {}
func (CursorHide) isClientMsg()      {}
func (InkPoints) isClientMsg()       {}
func (InkEnd) isClientMsg()          {}
func (InkClear) isClientMsg()        {}
func (Signal) isClientMsg()          {}
func (Leave) isClientMsg()           {}

// ---- Server → client ----

type Welcome struct {
	You         string      `json:"you"`
	ResumeToken string      `json:"resumeToken"`
	Polite      bool        `json:"polite"`
	IceServers  []IceServer `json:"iceServers"`
	Snapshot    Snapshot    `json:"snapshot"`
}

type Pong struct {
	T0         float64 `json:"t0"`
	ServerTime int64   `json:"serverTime"`
}

type ParticipantJoined struct {
	Participant Participant `json:"participant"`
}

type ParticipantReconnecting struct {
	ID string `json:"id"`
}

type ParticipantLeft struct {
	ID string `json:"id"`
}

type PlaybackUpdate struct {
	State PlaybackState `json:"state"`
}

type CamUpdate struct {
	CamID  string  `json:"camId"`
	Rect   Rect    `json:"rect"`
	Holder *string `json:"holder"`
}

type CursorRelay struct {
	From string  `json:"from"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

type CursorHideRelay struct {
	From string `json:"from"`
}

type InkPointsRelay struct {
	From     string  `json:"from"`
	StrokeID string  `json:"strokeId"`
	Mode     string  `json:"mode"`
	Color    string  `json:"color"`
	Width    float64 `json:"width"`
	Points   []Point `json:"points"`
}

type InkEndRelay struct {
	From     string `json:"from"`
	StrokeID string `json:"strokeId"`
}

type InkClearRelay struct {
	From string `json:"from"`
}

type SignalRelay struct {
	From string          `json:"from"`
	Data json.RawMessage `json:"data"`
}

type ErrorMsg struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (Welcome) MsgType() string                 { return "welcome" }
func (Pong) MsgType() string                    { return "pong" }
func (ParticipantJoined) MsgType() string       { return "participant.joined" }
func (ParticipantReconnecting) MsgType() string { return "participant.reconnecting" }
func (ParticipantLeft) MsgType() string         { return "participant.left" }
func (PlaybackUpdate) MsgType() string          { return "playback" }
func (CamUpdate) MsgType() string               { return "cam" }
func (CursorRelay) MsgType() string             { return "cursor" }
func (CursorHideRelay) MsgType() string         { return "cursor.hide" }
func (InkPointsRelay) MsgType() string          { return "ink.points" }
func (InkEndRelay) MsgType() string             { return "ink.end" }
func (InkClearRelay) MsgType() string           { return "ink.clear" }
func (SignalRelay) MsgType() string             { return "signal" }
func (ErrorMsg) MsgType() string                { return "error" }

// ---- Registries ----

type decoder func([]byte) (Message, error)

func decodeAs[T Message](data []byte) (Message, error) {
	var m T
	err := json.Unmarshal(data, &m)
	return m, err
}

var clientDecoders = map[string]decoder{
	Hello{}.MsgType():           decodeAs[Hello],
	Ping{}.MsgType():            decodeAs[Ping],
	PlaybackLoad{}.MsgType():    decodeAs[PlaybackLoad],
	PlaybackPlay{}.MsgType():    decodeAs[PlaybackPlay],
	PlaybackPause{}.MsgType():   decodeAs[PlaybackPause],
	PlaybackSeek{}.MsgType():    decodeAs[PlaybackSeek],
	PlaybackStalled{}.MsgType(): decodeAs[PlaybackStalled],
	PlaybackReady{}.MsgType():   decodeAs[PlaybackReady],
	CamGrab{}.MsgType():         decodeAs[CamGrab],
	CamMove{}.MsgType():         decodeAs[CamMove],
	CamRelease{}.MsgType():      decodeAs[CamRelease],
	Cursor{}.MsgType():          decodeAs[Cursor],
	CursorHide{}.MsgType():      decodeAs[CursorHide],
	InkPoints{}.MsgType():       decodeAs[InkPoints],
	InkEnd{}.MsgType():          decodeAs[InkEnd],
	InkClear{}.MsgType():        decodeAs[InkClear],
	Signal{}.MsgType():          decodeAs[Signal],
	Leave{}.MsgType():           decodeAs[Leave],
}

var serverDecoders = map[string]decoder{
	Welcome{}.MsgType():                 decodeAs[Welcome],
	Pong{}.MsgType():                    decodeAs[Pong],
	ParticipantJoined{}.MsgType():       decodeAs[ParticipantJoined],
	ParticipantReconnecting{}.MsgType(): decodeAs[ParticipantReconnecting],
	ParticipantLeft{}.MsgType():         decodeAs[ParticipantLeft],
	PlaybackUpdate{}.MsgType():          decodeAs[PlaybackUpdate],
	CamUpdate{}.MsgType():               decodeAs[CamUpdate],
	CursorRelay{}.MsgType():             decodeAs[CursorRelay],
	CursorHideRelay{}.MsgType():         decodeAs[CursorHideRelay],
	InkPointsRelay{}.MsgType():          decodeAs[InkPointsRelay],
	InkEndRelay{}.MsgType():             decodeAs[InkEndRelay],
	InkClearRelay{}.MsgType():           decodeAs[InkClearRelay],
	SignalRelay{}.MsgType():             decodeAs[SignalRelay],
	ErrorMsg{}.MsgType():                decodeAs[ErrorMsg],
}

// ClientTypes lists every client → server message type, sorted.
func ClientTypes() []string { return slices.Sorted(maps.Keys(clientDecoders)) }

// ServerTypes lists every server → client message type, sorted.
func ServerTypes() []string { return slices.Sorted(maps.Keys(serverDecoders)) }
```

- [ ] **Step 7: Write the codec**

`server/internal/protocol/codec.go`:

```go
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrBadMessage wraps every decoding and validation failure. The server
// answers these with an error message of code bad_message.
var ErrBadMessage = errors.New("bad message")

func badf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrBadMessage, fmt.Sprintf(format, args...))
}

// Encode marshals m and puts its "type" field first.
func Encode(m Message) ([]byte, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	typ, err := json.Marshal(m.MsgType())
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(body)+len(typ)+10)
	out = append(out, `{"type":`...)
	out = append(out, typ...)
	if len(body) > len("{}") {
		out = append(out, ',')
		out = append(out, body[1:]...)
	} else {
		out = append(out, '}')
	}
	return out, nil
}

// DecodeClient parses a message from the browser.
func DecodeClient(data []byte) (ClientMsg, error) {
	m, err := decode(data, clientDecoders)
	if err != nil {
		return nil, err
	}
	return m.(ClientMsg), nil
}

// DecodeServer parses a message from the server. The server never needs it;
// tests use it to read what the server sent.
func DecodeServer(data []byte) (Message, error) {
	return decode(data, serverDecoders)
}

func decode(data []byte, decoders map[string]decoder) (Message, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, badf("not a JSON object with a string type")
	}
	dec, ok := decoders[head.Type]
	if !ok {
		return nil, badf("unknown type %q", head.Type)
	}
	m, err := dec(data)
	if err != nil {
		return nil, badf("%s: %v", head.Type, err)
	}
	return m, nil
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `go -C server test -race ./internal/protocol/ -v`
Expected: PASS for `TestClientFixturesRoundTrip` (18 subtests), `TestServerFixturesRoundTrip` (14 subtests), `TestEveryFixtureMatchesAType` and `TestEncodePutsTypeFirst`.

- [ ] **Step 9: Commit**

```bash
git add server/go.mod server/internal/protocol protocol-fixtures
git commit -m "feat(server): protocol message types with shared JSON fixtures"
```

---

### Task 2: Validate and normalize client messages

**Files:**
- Create: `server/internal/protocol/validate.go`
- Modify: `server/internal/protocol/codec.go` (`DecodeClient`)
- Test: `server/internal/protocol/validate_test.go`

**Interfaces:**
- Consumes: `DecodeClient` and the message structs from Task 1.
- Produces:
  - `DecodeClient` now rejects bad messages with errors wrapping `ErrBadMessage`, and returns clamped values.
  - Constants `MaxNameRunes = 32`, `MaxIDLen = 64`, `MaxInkBatch = 64`.
  - Unexported `checkRequired(typ string, data []byte) error` and `normalize(ClientMsg) (ClientMsg, error)`.

- [ ] **Step 1: Write the failing tests**

`server/internal/protocol/validate_test.go`:

```go
package protocol

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDecodeClientRejects(t *testing.T) {
	tooManyPoints := strings.Repeat("[0.1,0.1],", MaxInkBatch) + "[0.1,0.1]"
	cases := map[string]string{
		"not JSON":            `nope`,
		"JSON array":          `[]`,
		"unknown type":        `{"type":"dance"}`,
		"missing type":        `{"position":1}`,
		"type is a number":    `{"type":5}`,
		"wrong field type":    `{"type":"playback.play","position":"ten"}`,
		"missing position":    `{"type":"playback.play"}`,
		"null position":       `{"type":"playback.play","position":null}`,
		"short video id":      `{"type":"playback.load","videoId":"short"}`,
		"video id with slash": `{"type":"playback.load","videoId":"abc/defghij"}`,
		"blank name":          `{"type":"hello","name":"   ","color":"#112233","pageSession":"p"}`,
		"long name":           fmt.Sprintf(`{"type":"hello","name":"%s","color":"#112233","pageSession":"p"}`, strings.Repeat("a", MaxNameRunes+1)),
		"bad color":           `{"type":"hello","name":"A","color":"red","pageSession":"p"}`,
		"missing pageSession": `{"type":"hello","name":"A","color":"#112233"}`,
		"long resume token":   fmt.Sprintf(`{"type":"hello","name":"A","color":"#112233","pageSession":"p","resumeToken":"%s"}`, strings.Repeat("t", MaxIDLen+1)),
		"empty cam id":        `{"type":"cam.grab","camId":""}`,
		"missing rect":        `{"type":"cam.move","camId":"c"}`,
		"bad ink mode":        `{"type":"ink.points","strokeId":"s","mode":"glitter","points":[[0,0]]}`,
		"empty ink batch":     `{"type":"ink.points","strokeId":"s","mode":"fading","points":[]}`,
		"oversized ink batch": `{"type":"ink.points","strokeId":"s","mode":"fading","points":[` + tooManyPoints + `]}`,
		"missing signal data": `{"type":"signal"}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			m, err := DecodeClient([]byte(raw))
			if !errors.Is(err, ErrBadMessage) {
				t.Fatalf("got (%+v, %v), want ErrBadMessage", m, err)
			}
		})
	}
}

func TestDecodeClientNormalizes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want ClientMsg
	}{
		{"negative position becomes zero", `{"type":"playback.seek","position":-5}`, PlaybackSeek{Position: 0}},
		{"cursor is clamped to the stage", `{"type":"cursor","x":-0.2,"y":1.7}`, Cursor{X: 0, Y: 1}},
		{
			"rect is clamped to the unit square",
			`{"type":"cam.move","camId":"c","rect":{"x":-1,"y":0.5,"w":3,"h":0.2}}`,
			CamMove{CamID: "c", Rect: Rect{X: 0, Y: 0.5, W: 1, H: 0.2}},
		},
		{
			"ink points are clamped",
			`{"type":"ink.points","strokeId":"s","mode":"fading","color":"#000000","width":0.004,"points":[[-1,2],[0.5,0.5]]}`,
			InkPoints{StrokeID: "s", Mode: InkFading, Color: "#000000", Width: 0.004, Points: []Point{{0, 1}, {0.5, 0.5}}},
		},
		{
			"name is trimmed",
			`{"type":"hello","name":"  Alex  ","color":"#112233","pageSession":"p"}`,
			Hello{Name: "Alex", Color: "#112233", PageSession: "p"},
		},
		{"messages without fields are fine", `{"type":"playback.stalled"}`, PlaybackStalled{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := DecodeClient([]byte(c.raw))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %+v, want %+v", got, c.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/protocol/ -run 'TestDecodeClient'`
Expected: FAIL. `TestDecodeClientRejects` subtests such as `short_video_id` and `missing_position` report `want ErrBadMessage`, and `TestDecodeClientNormalizes` reports unclamped values. (`not_JSON`, `unknown_type` and `wrong_field_type` already pass.)

- [ ] **Step 3: Write the validation rules**

`server/internal/protocol/validate.go`:

```go
package protocol

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MaxNameRunes = 32
	MaxIDLen     = 64 // participant IDs, cam IDs, stroke IDs, tokens, page sessions
	MaxInkBatch  = 64 // points per ink.points message
)

var (
	videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	colorPattern   = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// requiredFields lists fields that must be present and non-null. Fields not
// listed may be omitted and take their zero value.
var requiredFields = map[string][]string{
	Hello{}.MsgType():         {"name", "color", "pageSession"},
	Ping{}.MsgType():          {"t0"},
	PlaybackLoad{}.MsgType():  {"videoId"},
	PlaybackPlay{}.MsgType():  {"position"},
	PlaybackPause{}.MsgType(): {"position"},
	PlaybackSeek{}.MsgType():  {"position"},
	CamGrab{}.MsgType():       {"camId"},
	CamMove{}.MsgType():       {"camId", "rect"},
	CamRelease{}.MsgType():    {"camId", "rect"},
	Cursor{}.MsgType():        {"x", "y"},
	InkPoints{}.MsgType():     {"strokeId", "mode", "points"},
	InkEnd{}.MsgType():        {"strokeId"},
	Signal{}.MsgType():        {"data"},
}

func checkRequired(typ string, data []byte) error {
	fields := requiredFields[typ]
	if len(fields) == 0 {
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return badf("not a JSON object")
	}
	for _, f := range fields {
		if v, ok := obj[f]; !ok || string(v) == "null" {
			return badf("%s: missing %s", typ, f)
		}
	}
	return nil
}

// normalize rejects messages the server can't use and clamps the rest:
// coordinates to [0,1] and playback positions to >= 0.
func normalize(m ClientMsg) (ClientMsg, error) {
	switch v := m.(type) {
	case Hello:
		v.Name = strings.TrimSpace(v.Name)
		if n := utf8.RuneCountInString(v.Name); n == 0 || n > MaxNameRunes {
			return nil, badf("hello: name must be 1-%d characters", MaxNameRunes)
		}
		if !colorPattern.MatchString(v.Color) {
			return nil, badf("hello: color must look like #rrggbb")
		}
		if !validID(v.PageSession) {
			return nil, badf("hello: bad pageSession")
		}
		if len(v.ResumeToken) > MaxIDLen {
			return nil, badf("hello: bad resumeToken")
		}
		return v, nil
	case PlaybackLoad:
		if !videoIDPattern.MatchString(v.VideoID) {
			return nil, badf("playback.load: videoId must be 11 characters of A-Z a-z 0-9 _ -")
		}
		return v, nil
	case PlaybackPlay:
		v.Position = max(v.Position, 0)
		return v, nil
	case PlaybackPause:
		v.Position = max(v.Position, 0)
		return v, nil
	case PlaybackSeek:
		v.Position = max(v.Position, 0)
		return v, nil
	case CamGrab:
		if !validID(v.CamID) {
			return nil, badf("cam.grab: bad camId")
		}
		return v, nil
	case CamMove:
		if !validID(v.CamID) {
			return nil, badf("cam.move: bad camId")
		}
		v.Rect = unitRect(v.Rect)
		return v, nil
	case CamRelease:
		if !validID(v.CamID) {
			return nil, badf("cam.release: bad camId")
		}
		v.Rect = unitRect(v.Rect)
		return v, nil
	case Cursor:
		v.X, v.Y = unit(v.X), unit(v.Y)
		return v, nil
	case InkPoints:
		if !validID(v.StrokeID) {
			return nil, badf("ink.points: bad strokeId")
		}
		if v.Mode != InkFading && v.Mode != InkSticky {
			return nil, badf("ink.points: mode must be %q or %q", InkFading, InkSticky)
		}
		if len(v.Points) == 0 || len(v.Points) > MaxInkBatch {
			return nil, badf("ink.points: a batch must have 1-%d points", MaxInkBatch)
		}
		for i, p := range v.Points {
			v.Points[i] = Point{unit(p[0]), unit(p[1])}
		}
		return v, nil
	case InkEnd:
		if !validID(v.StrokeID) {
			return nil, badf("ink.end: bad strokeId")
		}
		return v, nil
	}
	return m, nil
}

func validID(s string) bool { return s != "" && len(s) <= MaxIDLen }

func unit(v float64) float64 { return min(max(v, 0), 1) }

func unitRect(r Rect) Rect { return Rect{X: unit(r.X), Y: unit(r.Y), W: unit(r.W), H: unit(r.H)} }
```

- [ ] **Step 4: Call the validation from `DecodeClient`**

In `server/internal/protocol/codec.go`, replace the `DecodeClient` function with:

```go
// DecodeClient parses and validates a message from the browser. Numbers are
// clamped to their allowed ranges; anything else invalid is an ErrBadMessage.
func DecodeClient(data []byte) (ClientMsg, error) {
	m, err := decode(data, clientDecoders)
	if err != nil {
		return nil, err
	}
	if err := checkRequired(m.MsgType(), data); err != nil {
		return nil, err
	}
	return normalize(m.(ClientMsg))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go -C server test -race ./internal/protocol/`
Expected: `ok  popcorn/internal/protocol`. The fixture round-trip tests still pass, which proves the fixtures are already normalized.

- [ ] **Step 6: Commit**

```bash
git add server/internal/protocol
git commit -m "feat(server): validate and clamp incoming client messages"
```

---

### Task 3: Room state, IDs and geometry helpers

**Files:**
- Create: `server/internal/room/ids.go`, `server/internal/room/state.go`
- Test: `server/internal/room/state_test.go`

**Interfaces:**
- Consumes: `protocol.Rect`, `protocol.PlaybackState`, `protocol.Snapshot`, `protocol.CamState`, `protocol.Stroke`, `protocol.Participant`.
- Produces (package `popcorn/internal/room`):
  - **IDs:** `NewRoomID() string` (22 characters), `NewParticipantID() string` (11), `NewResumeToken() string` (22).
  - **Constants:** `MaxParticipants`, `GracePeriod`, `EmptyRoomTTL`, `MinCamWidth`, `DefaultCamWidth`, `InkWidth`, `MaxStrokePoints`, `MaxStickyStrokes`, `MaxStickyPoints`.
  - **`Participant`:** embeds `protocol.Participant`, plus `ResumeToken`, `Polite`, `ConnID uint64` (0 = disconnected), `DisconnectedAt` and the method `Connected() bool`.
  - **`RoomState`:** `Participants`, `Playback`, `Cams map[string]protocol.CamState`, `Sticky []protocol.Stroke`, an unexported `stickyPoints int`, `EmptySince` and `Expired`.
  - **Functions:**
    - `NewRoomState(now time.Time) RoomState`
    - `ExpectedPosition(protocol.PlaybackState, time.Time) float64`
    - `ClampCamRect(protocol.Rect) protocol.Rect`
    - `(RoomState) Snapshot() protocol.Snapshot`
  - **Unexported:** `defaultCamRect(polite bool) protocol.Rect`, `(*RoomState) byConn(uint64) int`, `(*RoomState) byToken(string) int`, `clamp`.

- [ ] **Step 1: Write the failing tests**

`server/internal/room/state_test.go` (it also defines `t0`, `approx` and `rectApprox`, which later test files reuse):

```go
package room

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"popcorn/internal/protocol"
)

var t0 = time.Date(2026, 10, 1, 20, 0, 0, 0, time.UTC)

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func rectApprox(a, b protocol.Rect) bool {
	return approx(a.X, b.X) && approx(a.Y, b.Y) && approx(a.W, b.W) && approx(a.H, b.H)
}

func TestExpectedPosition(t *testing.T) {
	paused := protocol.PlaybackState{Position: 10, UpdatedAt: t0.UnixMilli()}
	if got := ExpectedPosition(paused, t0.Add(time.Minute)); got != 10 {
		t.Errorf("paused: got %v, want 10", got)
	}
	playing := protocol.PlaybackState{Playing: true, Position: 10, UpdatedAt: t0.UnixMilli()}
	if got := ExpectedPosition(playing, t0.Add(2500*time.Millisecond)); !approx(got, 12.5) {
		t.Errorf("playing: got %v, want 12.5", got)
	}
	if got := ExpectedPosition(playing, t0.Add(-time.Second)); got != 10 {
		t.Errorf("clock before updatedAt: got %v, want 10", got)
	}
}

func TestClampCamRect(t *testing.T) {
	cases := []struct {
		name    string
		in, out protocol.Rect
	}{
		{"inside is unchanged", protocol.Rect{X: 0.1, Y: 0.1, W: 0.2, H: 0.2}, protocol.Rect{X: 0.1, Y: 0.1, W: 0.2, H: 0.2}},
		{"off the left edge", protocol.Rect{X: -0.1, Y: 0.1, W: 0.2, H: 0.2}, protocol.Rect{X: 0, Y: 0.1, W: 0.2, H: 0.2}},
		{"off the bottom-right", protocol.Rect{X: 0.9, Y: 0.9, W: 0.2, H: 0.2}, protocol.Rect{X: 0.8, Y: 0.8, W: 0.2, H: 0.2}},
		{"too small keeps aspect", protocol.Rect{X: 0, Y: 0, W: 0.04, H: 0.03}, protocol.Rect{X: 0, Y: 0, W: 0.08, H: 0.06}},
		{"too wide keeps aspect", protocol.Rect{X: 0.5, Y: 0, W: 2, H: 1}, protocol.Rect{X: 0, Y: 0, W: 1, H: 0.5}},
		{"too tall keeps aspect", protocol.Rect{X: 0, Y: 0, W: 0.5, H: 2}, protocol.Rect{X: 0, Y: 0, W: 0.25, H: 1}},
		{"zero size gets the minimum", protocol.Rect{X: 0.5, Y: 0.5}, protocol.Rect{X: 0.5, Y: 0.5, W: 0.08, H: 0.08}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ClampCamRect(c.in); !rectApprox(got, c.out) {
				t.Errorf("ClampCamRect(%+v) = %+v, want %+v", c.in, got, c.out)
			}
		})
	}
}

func TestDefaultCamRects(t *testing.T) {
	left, right := defaultCamRect(false), defaultCamRect(true)
	if !rectApprox(left, protocol.Rect{X: 0.02, Y: 0.745, W: 0.22, H: 0.22}) {
		t.Errorf("impolite default = %+v", left)
	}
	if !rectApprox(right, protocol.Rect{X: 0.76, Y: 0.745, W: 0.22, H: 0.22}) {
		t.Errorf("polite default = %+v", right)
	}
}

func TestEmptySnapshotEncodesWithoutNulls(t *testing.T) {
	b, err := json.Marshal(NewRoomState(t0).Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"participants":[]`, `"cams":{}`, `"stickyStrokes":[]`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("snapshot %s is missing %s", b, want)
		}
	}
}

func TestIDs(t *testing.T) {
	if n := len(NewRoomID()); n != 22 {
		t.Errorf("room ID length %d, want 22", n)
	}
	if n := len(NewParticipantID()); n != 11 {
		t.Errorf("participant ID length %d, want 11", n)
	}
	if n := len(NewResumeToken()); n != 22 {
		t.Errorf("resume token length %d, want 22", n)
	}
	if NewRoomID() == NewRoomID() {
		t.Error("two room IDs were equal")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/room/`
Expected: FAIL to compile with `undefined: ExpectedPosition`, `undefined: ClampCamRect`, and similar errors.

- [ ] **Step 3: Write the ID helpers**

`server/internal/room/ids.go`:

```go
package room

import (
	"crypto/rand"
	"encoding/base64"
)

func randomID(nBytes int) string {
	b := make([]byte, nBytes)
	rand.Read(b) // crypto/rand.Read never returns an error
	return base64.RawURLEncoding.EncodeToString(b)
}

// NewRoomID returns 128 random bits as 22 base64url characters.
func NewRoomID() string { return randomID(16) }

// NewParticipantID returns 64 random bits as 11 base64url characters.
func NewParticipantID() string { return randomID(8) }

// NewResumeToken returns 128 random bits as 22 base64url characters.
func NewResumeToken() string { return randomID(16) }
```

- [ ] **Step 4: Write the state and helpers**

`server/internal/room/state.go`:

```go
package room

import (
	"maps"
	"time"

	"popcorn/internal/protocol"
)

const (
	MaxParticipants  = 2
	GracePeriod      = 30 * time.Second
	EmptyRoomTTL     = 30 * time.Minute
	MinCamWidth      = 0.08
	DefaultCamWidth  = 0.22
	InkWidth         = 0.004
	MaxStrokePoints  = 2000
	MaxStickyStrokes = 500
	MaxStickyPoints  = 100_000
)

// Participant is someone in the room: connected, or disconnected and inside
// their grace period.
type Participant struct {
	protocol.Participant
	ResumeToken    string
	Polite         bool
	ConnID         uint64    // 0 while disconnected
	DisconnectedAt time.Time // zero while connected
}

func (p Participant) Connected() bool { return p.ConnID != 0 }

// RoomState is everything the server knows about one room. Only the room's
// hub goroutine touches it, and only through Apply.
type RoomState struct {
	Participants []Participant
	Playback     protocol.PlaybackState
	Cams         map[string]protocol.CamState // keyed by participant ID
	Sticky       []protocol.Stroke
	stickyPoints int
	EmptySince   time.Time // zero while anyone holds a seat
	Expired      bool
}

func NewRoomState(now time.Time) RoomState {
	return RoomState{Cams: map[string]protocol.CamState{}, EmptySince: now}
}

// ExpectedPosition is where playback should be at server time now.
func ExpectedPosition(p protocol.PlaybackState, now time.Time) float64 {
	if !p.Playing {
		return p.Position
	}
	elapsed := float64(now.UnixMilli()-p.UpdatedAt) / 1000
	return p.Position + max(elapsed, 0)
}

// ClampCamRect keeps a cam inside the stage and at least MinCamWidth wide,
// preserving the rectangle's own width-to-height ratio where it can.
func ClampCamRect(r protocol.Rect) protocol.Rect {
	if r.W <= 0 || r.H <= 0 {
		r.W, r.H = MinCamWidth, MinCamWidth
	}
	if r.W < MinCamWidth {
		r.H *= MinCamWidth / r.W
		r.W = MinCamWidth
	}
	if r.W > 1 {
		r.H /= r.W
		r.W = 1
	}
	if r.H > 1 {
		r.W /= r.H
		r.H = 1
	}
	r.W = max(r.W, MinCamWidth) // only for absurdly tall rectangles
	r.X = clamp(r.X, 0, 1-r.W)
	r.Y = clamp(r.Y, 0, 1-r.H)
	return r
}

// defaultCamRect puts the impolite participant bottom-left and the polite one
// bottom-right. h == w because a 16:9 camera on a 16:9 stage has equal
// fractions.
func defaultCamRect(polite bool) protocol.Rect {
	const marginX, marginY = 0.02, 0.035
	x := marginX
	if polite {
		x = 1 - marginX - DefaultCamWidth
	}
	return protocol.Rect{X: x, Y: 1 - marginY - DefaultCamWidth, W: DefaultCamWidth, H: DefaultCamWidth}
}

// Snapshot is the room as sent in welcome. Slices and maps are never nil so
// they encode as [] and {}.
func (s RoomState) Snapshot() protocol.Snapshot {
	ps := make([]protocol.SnapshotParticipant, 0, len(s.Participants))
	for _, p := range s.Participants {
		ps = append(ps, protocol.SnapshotParticipant{Participant: p.Participant, Connected: p.Connected()})
	}
	cams := make(map[string]protocol.CamState, len(s.Cams))
	maps.Copy(cams, s.Cams)
	strokes := make([]protocol.Stroke, len(s.Sticky))
	copy(strokes, s.Sticky)
	return protocol.Snapshot{Participants: ps, Playback: s.Playback, Cams: cams, StickyStrokes: strokes}
}

func (s *RoomState) byConn(connID uint64) int {
	if connID == 0 {
		return -1
	}
	for i, p := range s.Participants {
		if p.ConnID == connID {
			return i
		}
	}
	return -1
}

func (s *RoomState) byToken(token string) int {
	if token == "" {
		return -1
	}
	for i, p := range s.Participants {
		if p.ResumeToken == token {
			return i
		}
	}
	return -1
}

func clamp(v, lo, hi float64) float64 { return min(max(v, lo), hi) }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go -C server test -race ./internal/room/ -v`
Expected: PASS for `TestExpectedPosition`, `TestClampCamRect` (7 subtests), `TestDefaultCamRects`, `TestEmptySnapshotEncodesWithoutNulls` and `TestIDs`.

- [ ] **Step 6: Commit**

```bash
git add server/internal/room
git commit -m "feat(server): room state, IDs, expected position and cam clamping"
```

---

### Task 4: Reducer core (joining, resuming, leaving, expiry)

**Files:**
- Create: `server/internal/room/reducer.go`
- Test: `server/internal/room/helpers_test.go`, `server/internal/room/membership_test.go`

**Interfaces:**
- Consumes: everything from Task 3, plus `protocol.Hello`, `protocol.Ping`, `protocol.Leave`, `protocol.Welcome`, `protocol.Pong`, `protocol.ParticipantJoined`, `protocol.ParticipantReconnecting`, `protocol.ParticipantLeft`, `protocol.CamUpdate` and `protocol.ErrorMsg`.
- Produces:
  - **Events** (`Event` interface):
    - `HelloEvent{ConnID uint64; Hello protocol.Hello; NewID, NewToken string; IceServers []protocol.IceServer}`
    - `MessageEvent{ConnID uint64; Msg protocol.ClientMsg}`
    - `DisconnectEvent{ConnID uint64}`
    - `TickEvent{}`
  - **`Outbound{ConnID uint64; Msg protocol.Message; Close int}`**
  - **`Apply(s RoomState, ev Event, now time.Time) (RoomState, []Outbound)`**
  - **Unexported reducer methods that Tasks 5 and 6 extend:** `send`, `closeConn`, `broadcast`, `toOthers`, `message`, `disconnect`, `remove`.
  - **Test helpers:** `harness` (`newHarness`, `apply`, `advance`, `hello`, `join`, `send`, `participant`), `msgsTo`, `one[T]`, `none`, `closeCode`. With these helpers, connection `n` joins as participant `"p<n>"` with token `"tok-p<n>"` and color `#112233`.

- [ ] **Step 1: Write the test helpers**

`server/internal/room/helpers_test.go`:

```go
package room

import (
	"fmt"
	"testing"
	"time"

	"popcorn/internal/protocol"
)

// harness drives Apply with a fake clock. Connection n joins as participant
// "p<n>" with resume token "tok-p<n>".
type harness struct {
	t   *testing.T
	s   RoomState
	now time.Time
}

func newHarness(t *testing.T) *harness {
	return &harness{t: t, s: NewRoomState(t0), now: t0}
}

func (h *harness) apply(ev Event) []Outbound {
	var out []Outbound
	h.s, out = Apply(h.s, ev, h.now)
	return out
}

func (h *harness) advance(d time.Duration) { h.now = h.now.Add(d) }

func (h *harness) hello(connID uint64, token string) []Outbound {
	id := fmt.Sprintf("p%d", connID)
	return h.apply(HelloEvent{
		ConnID:   connID,
		Hello:    protocol.Hello{Name: "Name " + id, Color: "#112233", PageSession: "ps-" + id, ResumeToken: token},
		NewID:    id,
		NewToken: "tok-" + id,
	})
}

func (h *harness) join(connID uint64) string {
	h.t.Helper()
	one[protocol.Welcome](h.t, h.hello(connID, ""), connID)
	return fmt.Sprintf("p%d", connID)
}

func (h *harness) send(connID uint64, m protocol.ClientMsg) []Outbound {
	return h.apply(MessageEvent{ConnID: connID, Msg: m})
}

func (h *harness) participant(id string) Participant {
	h.t.Helper()
	for _, p := range h.s.Participants {
		if p.ID == id {
			return p
		}
	}
	h.t.Fatalf("no participant %s", id)
	return Participant{}
}

func msgsTo(out []Outbound, connID uint64) []protocol.Message {
	var ms []protocol.Message
	for _, o := range out {
		if o.ConnID == connID && o.Msg != nil {
			ms = append(ms, o.Msg)
		}
	}
	return ms
}

// one asserts that exactly one message of type T went to connID.
func one[T protocol.Message](t *testing.T, out []Outbound, connID uint64) T {
	t.Helper()
	var found []T
	for _, m := range msgsTo(out, connID) {
		if v, ok := m.(T); ok {
			found = append(found, v)
		}
	}
	if len(found) != 1 {
		t.Fatalf("conn %d got %d %T messages, want 1; all: %+v", connID, len(found), *new(T), msgsTo(out, connID))
	}
	return found[0]
}

func none(t *testing.T, out []Outbound, connID uint64) {
	t.Helper()
	if ms := msgsTo(out, connID); len(ms) > 0 {
		t.Fatalf("conn %d got %+v, want nothing", connID, ms)
	}
}

func closeCode(out []Outbound, connID uint64) int {
	for _, o := range out {
		if o.ConnID == connID && o.Close != 0 {
			return o.Close
		}
	}
	return 0
}
```

- [ ] **Step 2: Write the failing membership tests**

`server/internal/room/membership_test.go`:

```go
package room

import (
	"testing"
	"time"

	"popcorn/internal/protocol"
)

func TestFirstJoinIsImpoliteAndBottomLeft(t *testing.T) {
	h := newHarness(t)
	ice := []protocol.IceServer{{URLs: []string{"stun:example.org"}}}
	out := h.apply(HelloEvent{ConnID: 1, Hello: protocol.Hello{Name: "Alex", Color: "#112233", PageSession: "ps"}, NewID: "p1", NewToken: "tok-p1", IceServers: ice})
	w := one[protocol.Welcome](t, out, 1)
	if w.You != "p1" || w.ResumeToken != "tok-p1" || w.Polite {
		t.Errorf("welcome = %+v", w)
	}
	if len(w.IceServers) != 1 {
		t.Errorf("ice servers = %+v", w.IceServers)
	}
	if len(w.Snapshot.Participants) != 1 || !w.Snapshot.Participants[0].Connected {
		t.Errorf("participants = %+v", w.Snapshot.Participants)
	}
	if !rectApprox(w.Snapshot.Cams["p1"].Rect, defaultCamRect(false)) {
		t.Errorf("cam = %+v", w.Snapshot.Cams["p1"])
	}
}

func TestSecondJoinIsPoliteAndAnnounced(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	out := h.hello(2, "")
	if w := one[protocol.Welcome](t, out, 2); !w.Polite || len(w.Snapshot.Participants) != 2 {
		t.Errorf("welcome = %+v", w)
	}
	if j := one[protocol.ParticipantJoined](t, out, 1); j.Participant.ID != "p2" {
		t.Errorf("joined = %+v", j)
	}
	if c := one[protocol.CamUpdate](t, out, 1); c.CamID != "p2" || !rectApprox(c.Rect, defaultCamRect(true)) {
		t.Errorf("cam = %+v", c)
	}
}

func TestThirdPersonGetsRoomFull(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	out := h.hello(3, "")
	if e := one[protocol.ErrorMsg](t, out, 3); e.Code != protocol.CodeRoomFull {
		t.Errorf("error = %+v", e)
	}
	if code := closeCode(out, 3); code != protocol.CloseRoomFull {
		t.Errorf("close code = %d", code)
	}
	none(t, out, 1)
	if len(h.s.Participants) != 2 {
		t.Errorf("participants = %d", len(h.s.Participants))
	}
}

func TestRoomFullWhileSeatIsHeld(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	h.apply(DisconnectEvent{ConnID: 2})
	out := h.hello(3, "")
	if code := closeCode(out, 3); code != protocol.CloseRoomFull {
		t.Fatalf("a stranger took a held seat; close code = %d", code)
	}
	out = h.hello(4, "tok-p2")
	if w := one[protocol.Welcome](t, out, 4); w.You != "p2" {
		t.Errorf("resume welcome = %+v", w)
	}
}

func TestDisconnectHoldsSeat(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	out := h.apply(DisconnectEvent{ConnID: 2})
	if r := one[protocol.ParticipantReconnecting](t, out, 1); r.ID != "p2" {
		t.Errorf("reconnecting = %+v", r)
	}
	if p := h.participant("p2"); p.Connected() || !p.DisconnectedAt.Equal(t0) {
		t.Errorf("participant = %+v", p)
	}
}

func TestResumeWithinGracePeriod(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	h.apply(DisconnectEvent{ConnID: 2})
	h.advance(29 * time.Second)
	h.apply(TickEvent{})
	out := h.apply(HelloEvent{ConnID: 5, Hello: protocol.Hello{Name: "Sam", Color: "#445566", PageSession: "ps-new", ResumeToken: "tok-p2"}, NewID: "unused", NewToken: "unused"})
	w := one[protocol.Welcome](t, out, 5)
	if w.You != "p2" || !w.Polite || w.ResumeToken != "tok-p2" {
		t.Errorf("welcome = %+v", w)
	}
	if j := one[protocol.ParticipantJoined](t, out, 1); j.Participant.PageSession != "ps-new" {
		t.Errorf("joined = %+v", j)
	}
	if p := h.participant("p2"); p.ConnID != 5 || p.Name != "Sam" {
		t.Errorf("participant = %+v", p)
	}
}

func TestGracePeriodExpiry(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	h.apply(DisconnectEvent{ConnID: 2})
	h.advance(GracePeriod)
	out := h.apply(TickEvent{})
	if l := one[protocol.ParticipantLeft](t, out, 1); l.ID != "p2" {
		t.Errorf("left = %+v", l)
	}
	if _, ok := h.s.Cams["p2"]; ok {
		t.Error("cam p2 should be removed")
	}
	// The old token no longer works, so this is a brand-new participant.
	out = h.hello(7, "tok-p2")
	if w := one[protocol.Welcome](t, out, 7); w.You != "p7" {
		t.Errorf("welcome = %+v", w)
	}
}

func TestNewcomerTakesTheFreeRole(t *testing.T) {
	h := newHarness(t)
	h.join(1) // impolite
	h.join(2) // polite
	h.send(1, protocol.Leave{})
	out := h.hello(3, "")
	w := one[protocol.Welcome](t, out, 3)
	if w.Polite {
		t.Fatal("both participants are polite; perfect negotiation needs one of each")
	}
	if !rectApprox(w.Snapshot.Cams["p3"].Rect, defaultCamRect(false)) {
		t.Errorf("impolite newcomer should be bottom-left, got %+v", w.Snapshot.Cams["p3"])
	}
}

func TestResumeReplacesStaleConnection(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	out := h.hello(9, "tok-p1") // the server never noticed conn 1 die
	if code := closeCode(out, 1); code != protocol.CloseReplaced {
		t.Errorf("old connection close code = %d", code)
	}
	if w := one[protocol.Welcome](t, out, 9); w.You != "p1" {
		t.Errorf("welcome = %+v", w)
	}
	if p := h.participant("p1"); p.ConnID != 9 {
		t.Errorf("participant conn = %d", p.ConnID)
	}
	// A late disconnect from the replaced connection changes nothing.
	if out := h.apply(DisconnectEvent{ConnID: 1}); len(out) != 0 {
		t.Errorf("stale disconnect produced %+v", out)
	}
}

func TestLeaveFreesSeatImmediately(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	out := h.send(2, protocol.Leave{})
	if code := closeCode(out, 2); code != protocol.CloseNormal {
		t.Errorf("close code = %d", code)
	}
	if l := one[protocol.ParticipantLeft](t, out, 1); l.ID != "p2" {
		t.Errorf("left = %+v", l)
	}
	if len(h.s.Participants) != 1 {
		t.Errorf("participants = %d", len(h.s.Participants))
	}
}

func TestSecondHelloIsBadMessage(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	out := h.send(1, protocol.Hello{Name: "Again", Color: "#112233", PageSession: "x"})
	if e := one[protocol.ErrorMsg](t, out, 1); e.Code != protocol.CodeBadMessage {
		t.Errorf("error = %+v", e)
	}
}

func TestMessagesFromUnknownConnectionsAreIgnored(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	if out := h.send(42, protocol.Ping{T0: 1}); len(out) != 0 {
		t.Errorf("got %+v", out)
	}
}

func TestPingGetsPong(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.advance(1500 * time.Millisecond)
	p := one[protocol.Pong](t, h.send(1, protocol.Ping{T0: 123}), 1)
	if p.T0 != 123 || p.ServerTime != h.now.UnixMilli() {
		t.Errorf("pong = %+v", p)
	}
}

func TestEmptyRoomExpires(t *testing.T) {
	h := newHarness(t)
	h.advance(EmptyRoomTTL - time.Second)
	h.apply(TickEvent{})
	if h.s.Expired {
		t.Fatal("expired too early")
	}
	h.advance(time.Second)
	h.apply(TickEvent{})
	if !h.s.Expired {
		t.Fatal("never-joined room should expire after 30 minutes")
	}
}

func TestExpiryCountsFromWhenRoomEmptied(t *testing.T) {
	h := newHarness(t)
	h.advance(20 * time.Minute)
	h.join(1)
	h.advance(20 * time.Minute)
	h.send(1, protocol.Leave{})
	h.advance(EmptyRoomTTL - time.Second)
	h.apply(TickEvent{})
	if h.s.Expired {
		t.Fatal("expired too early")
	}
	h.advance(time.Second)
	h.apply(TickEvent{})
	if !h.s.Expired {
		t.Fatal("room should expire 30 minutes after it emptied")
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/room/`
Expected: FAIL to compile with `undefined: Apply`, `undefined: HelloEvent`, `undefined: Outbound`, and similar errors.

- [ ] **Step 4: Write the reducer**

`server/internal/room/reducer.go`:

```go
package room

import (
	"slices"
	"time"

	"popcorn/internal/protocol"
)

// Event is something that happened to a room.
type Event interface{ isEvent() }

// HelloEvent is a connection's first message. The caller supplies fresh IDs
// and the ICE servers so that Apply stays deterministic.
type HelloEvent struct {
	ConnID     uint64
	Hello      protocol.Hello
	NewID      string
	NewToken   string
	IceServers []protocol.IceServer
}

// MessageEvent is any message after hello.
type MessageEvent struct {
	ConnID uint64
	Msg    protocol.ClientMsg
}

// DisconnectEvent means a connection has gone away.
type DisconnectEvent struct{ ConnID uint64 }

// TickEvent arrives about once a second so Apply can expire grace periods
// and the room itself.
type TickEvent struct{}

func (HelloEvent) isEvent()      {}
func (MessageEvent) isEvent()    {}
func (DisconnectEvent) isEvent() {}
func (TickEvent) isEvent()       {}

// Outbound is a message for one connection. If Close is non-zero, the
// connection is closed with that WebSocket status code after Msg (if any) is
// sent.
type Outbound struct {
	ConnID uint64
	Msg    protocol.Message
	Close  int
}

// Apply is the room's only state transition. It is deterministic: randomness
// and time arrive through ev and now. Apply may modify the maps and slices
// inside s, so callers must use the returned state and discard s.
func Apply(s RoomState, ev Event, now time.Time) (RoomState, []Outbound) {
	r := reducer{s: s, now: now}
	switch ev := ev.(type) {
	case HelloEvent:
		r.hello(ev)
	case MessageEvent:
		r.message(ev)
	case DisconnectEvent:
		r.disconnect(ev.ConnID)
	case TickEvent:
		r.tick()
	}
	return r.s, r.out
}

type reducer struct {
	s   RoomState
	now time.Time
	out []Outbound
}

func (r *reducer) send(connID uint64, m protocol.Message) {
	r.out = append(r.out, Outbound{ConnID: connID, Msg: m})
}

func (r *reducer) closeConn(connID uint64, m protocol.Message, code int) {
	r.out = append(r.out, Outbound{ConnID: connID, Msg: m, Close: code})
}

func (r *reducer) broadcast(m protocol.Message) {
	for _, p := range r.s.Participants {
		if p.Connected() {
			r.send(p.ConnID, m)
		}
	}
}

func (r *reducer) toOthers(id string, m protocol.Message) {
	for _, p := range r.s.Participants {
		if p.ID != id && p.Connected() {
			r.send(p.ConnID, m)
		}
	}
}

func badMessage(text string) protocol.ErrorMsg {
	return protocol.ErrorMsg{Code: protocol.CodeBadMessage, Message: text}
}

func (r *reducer) hello(ev HelloEvent) {
	if r.s.byConn(ev.ConnID) >= 0 {
		r.send(ev.ConnID, badMessage("already joined"))
		return
	}
	if i := r.s.byToken(ev.Hello.ResumeToken); i >= 0 {
		r.resume(i, ev)
		return
	}
	if len(r.s.Participants) >= MaxParticipants {
		r.closeConn(ev.ConnID, protocol.ErrorMsg{Code: protocol.CodeRoomFull, Message: "This room already has two people."}, protocol.CloseRoomFull)
		return
	}
	// The newcomer takes whichever role the person already here doesn't hold.
	polite := len(r.s.Participants) == 1 && !r.s.Participants[0].Polite
	p := Participant{
		Participant: protocol.Participant{
			ID: ev.NewID, Name: ev.Hello.Name, Color: ev.Hello.Color, PageSession: ev.Hello.PageSession,
		},
		ResumeToken: ev.NewToken,
		Polite:      polite,
		ConnID:      ev.ConnID,
	}
	r.s.Participants = append(r.s.Participants, p)
	cam := protocol.CamState{Rect: defaultCamRect(polite)}
	r.s.Cams[p.ID] = cam
	r.s.EmptySince = time.Time{}
	r.welcome(p, ev.IceServers)
	r.toOthers(p.ID, protocol.ParticipantJoined{Participant: p.Participant})
	r.toOthers(p.ID, protocol.CamUpdate{CamID: p.ID, Rect: cam.Rect})
}

func (r *reducer) resume(i int, ev HelloEvent) {
	p := &r.s.Participants[i]
	if p.Connected() {
		// The server still thinks the old connection is alive; the new one wins.
		r.closeConn(p.ConnID, nil, protocol.CloseReplaced)
	}
	p.ConnID, p.DisconnectedAt = ev.ConnID, time.Time{}
	p.Name, p.Color, p.PageSession = ev.Hello.Name, ev.Hello.Color, ev.Hello.PageSession
	r.welcome(*p, ev.IceServers)
	r.toOthers(p.ID, protocol.ParticipantJoined{Participant: p.Participant})
}

func (r *reducer) welcome(p Participant, ice []protocol.IceServer) {
	if ice == nil {
		ice = []protocol.IceServer{}
	}
	r.send(p.ConnID, protocol.Welcome{
		You: p.ID, ResumeToken: p.ResumeToken, Polite: p.Polite, IceServers: ice, Snapshot: r.s.Snapshot(),
	})
}

func (r *reducer) message(ev MessageEvent) {
	i := r.s.byConn(ev.ConnID)
	if i < 0 {
		return // not joined, or a connection that has been replaced
	}
	switch m := ev.Msg.(type) {
	case protocol.Hello:
		r.send(ev.ConnID, badMessage("already joined"))
	case protocol.Ping:
		r.send(ev.ConnID, protocol.Pong{T0: m.T0, ServerTime: r.now.UnixMilli()})
	case protocol.Leave:
		r.remove(i)
		r.closeConn(ev.ConnID, nil, protocol.CloseNormal)
	}
}

func (r *reducer) disconnect(connID uint64) {
	i := r.s.byConn(connID)
	if i < 0 {
		return
	}
	p := &r.s.Participants[i]
	p.ConnID, p.DisconnectedAt = 0, r.now
	r.toOthers(p.ID, protocol.ParticipantReconnecting{ID: p.ID})
}

func (r *reducer) tick() {
	for i := len(r.s.Participants) - 1; i >= 0; i-- {
		p := r.s.Participants[i]
		if !p.Connected() && r.now.Sub(p.DisconnectedAt) >= GracePeriod {
			r.remove(i)
		}
	}
	if len(r.s.Participants) == 0 && r.now.Sub(r.s.EmptySince) >= EmptyRoomTTL {
		r.s.Expired = true
	}
}

// remove frees a participant's seat: they left on purpose or their grace
// period ran out.
func (r *reducer) remove(i int) {
	p := r.s.Participants[i]
	r.s.Participants = slices.Delete(r.s.Participants, i, i+1)
	delete(r.s.Cams, p.ID)
	r.broadcast(protocol.ParticipantLeft{ID: p.ID})
	if len(r.s.Participants) == 0 {
		r.s.EmptySince = r.now
	}
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go -C server test -race ./internal/room/ -v`
Expected: every `Test…` in `membership_test.go` and `state_test.go` passes.

- [ ] **Step 6: Commit**

```bash
git add server/internal/room
git commit -m "feat(server): room reducer for joining, resuming, leaving and expiry"
```

---

### Task 5: Playback sync in the reducer

**Files:**
- Create: `server/internal/room/playback.go`
- Modify: `server/internal/room/reducer.go` (`message`, `disconnect`, `remove`)
- Test: `server/internal/room/playback_test.go`

**Interfaces:**
- Consumes: the reducer from Task 4, `ExpectedPosition`, `protocol.Playback*` messages and `protocol.PlaybackUpdate`.
- Produces: the reducer methods `playback(id string, m protocol.ClientMsg)`, `setPlayback`, `command`, `autoPause(id string)`, `ready(id string)` and `stopWaitingFor(id string)`.
- Behavior:
  - A partner disconnecting while playing auto-pauses with `waitingFor` set to that partner.
  - Removing a participant stops waiting for them, and playback stays paused.

- [ ] **Step 1: Write the failing tests**

`server/internal/room/playback_test.go`:

```go
package room

import (
	"testing"
	"time"

	"popcorn/internal/protocol"
)

const video = "dQw4w9WgXcQ"

// playingRoom has p1 and p2 joined and video playing from 10s since t0.
func playingRoom(t *testing.T) *harness {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	h.send(1, protocol.PlaybackLoad{VideoID: video})
	h.send(1, protocol.PlaybackPlay{Position: 10})
	return h
}

func TestLoadResetsPlaybackForBoth(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	h.send(1, protocol.PlaybackLoad{VideoID: "aaaaaaaaaaa"})
	h.send(1, protocol.PlaybackPlay{Position: 50})
	h.advance(time.Second)
	out := h.send(2, protocol.PlaybackLoad{VideoID: video})
	for _, conn := range []uint64{1, 2} {
		pb := one[protocol.PlaybackUpdate](t, out, conn).State
		if *pb.VideoID != video || pb.Playing || pb.Position != 0 || pb.UpdatedAt != h.now.UnixMilli() {
			t.Errorf("conn %d got %+v", conn, pb)
		}
	}
}

func TestCommandsWithoutVideoAreIgnored(t *testing.T) {
	h := newHarness(t)
	h.join(1)
	for _, m := range []protocol.ClientMsg{
		protocol.PlaybackPlay{Position: 1}, protocol.PlaybackPause{}, protocol.PlaybackSeek{Position: 3},
		protocol.PlaybackStalled{}, protocol.PlaybackReady{},
	} {
		if out := h.send(1, m); len(out) != 0 {
			t.Errorf("%T produced %+v", m, out)
		}
	}
}

func TestPlayPauseSeek(t *testing.T) {
	h := playingRoom(t)
	if pb := h.s.Playback; !pb.Playing || pb.Position != 10 || pb.UpdatedAt != t0.UnixMilli() {
		t.Fatalf("after play: %+v", pb)
	}
	h.advance(5 * time.Second)
	h.send(2, protocol.PlaybackSeek{Position: 100})
	if pb := h.s.Playback; !pb.Playing || pb.Position != 100 || pb.UpdatedAt != h.now.UnixMilli() {
		t.Fatalf("seek while playing should keep playing: %+v", pb)
	}
	h.send(2, protocol.PlaybackPause{Position: 101})
	h.send(1, protocol.PlaybackSeek{Position: 20})
	if pb := h.s.Playback; pb.Playing || pb.Position != 20 {
		t.Fatalf("seek while paused should stay paused: %+v", pb)
	}
}

func TestStallAutoPausesAtExpectedPosition(t *testing.T) {
	h := playingRoom(t)
	h.advance(5 * time.Second)
	out := h.send(2, protocol.PlaybackStalled{})
	for _, conn := range []uint64{1, 2} {
		pb := one[protocol.PlaybackUpdate](t, out, conn).State
		if pb.Playing || pb.Position != 15 || *pb.WaitingFor != "p2" || !pb.AutoResume {
			t.Errorf("conn %d got %+v", conn, pb)
		}
	}
}

func TestStallWhilePausedIsIgnored(t *testing.T) {
	h := playingRoom(t)
	h.send(1, protocol.PlaybackPause{Position: 12})
	if out := h.send(2, protocol.PlaybackStalled{}); len(out) != 0 {
		t.Errorf("got %+v", out)
	}
}

func TestReadyFromWaitedForParticipantResumes(t *testing.T) {
	h := playingRoom(t)
	h.advance(5 * time.Second)
	h.send(2, protocol.PlaybackStalled{})
	h.advance(3 * time.Second)
	if out := h.send(1, protocol.PlaybackReady{}); len(out) != 0 {
		t.Fatalf("ready from the wrong person resumed playback: %+v", out)
	}
	out := h.send(2, protocol.PlaybackReady{})
	pb := one[protocol.PlaybackUpdate](t, out, 1).State
	if !pb.Playing || pb.Position != 15 || pb.UpdatedAt != h.now.UnixMilli() || pb.WaitingFor != nil || pb.AutoResume {
		t.Errorf("got %+v", pb)
	}
}

func TestManualCommandClearsWaiting(t *testing.T) {
	h := playingRoom(t)
	h.send(2, protocol.PlaybackStalled{})
	h.send(1, protocol.PlaybackPlay{Position: 12})
	if pb := h.s.Playback; !pb.Playing || pb.WaitingFor != nil || pb.AutoResume {
		t.Fatalf("manual play should clear waiting: %+v", pb)
	}
	if out := h.send(2, protocol.PlaybackReady{}); len(out) != 0 {
		t.Errorf("a stale ready changed playback: %+v", out)
	}
}

func TestPartnerDropAutoPausesAndResumeContinues(t *testing.T) {
	h := playingRoom(t)
	h.advance(4 * time.Second)
	out := h.apply(DisconnectEvent{ConnID: 2})
	pb := one[protocol.PlaybackUpdate](t, out, 1).State
	if pb.Playing || pb.Position != 14 || *pb.WaitingFor != "p2" || !pb.AutoResume {
		t.Fatalf("got %+v", pb)
	}
	h.advance(10 * time.Second)
	out = h.hello(3, "tok-p2")
	if w := one[protocol.Welcome](t, out, 3); *w.Snapshot.Playback.WaitingFor != "p2" {
		t.Fatalf("snapshot should say we are waiting for p2: %+v", w.Snapshot.Playback)
	}
	out = h.send(3, protocol.PlaybackReady{})
	if pb := one[protocol.PlaybackUpdate](t, out, 1).State; !pb.Playing || pb.Position != 14 {
		t.Errorf("got %+v", pb)
	}
}

func TestDropWhilePausedDoesNotTouchPlayback(t *testing.T) {
	h := playingRoom(t)
	h.send(1, protocol.PlaybackPause{Position: 11})
	out := h.apply(DisconnectEvent{ConnID: 2})
	for _, m := range msgsTo(out, 1) {
		if _, ok := m.(protocol.PlaybackUpdate); ok {
			t.Fatalf("unexpected playback update: %+v", m)
		}
	}
}

func TestGraceExpiryStopsWaitingAndStaysPaused(t *testing.T) {
	h := playingRoom(t)
	h.apply(DisconnectEvent{ConnID: 2})
	h.advance(GracePeriod)
	out := h.apply(TickEvent{})
	pb := one[protocol.PlaybackUpdate](t, out, 1).State
	if pb.Playing || pb.WaitingFor != nil || pb.AutoResume {
		t.Errorf("got %+v", pb)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/room/`
Expected: FAIL with messages like `conn 1 got 0 protocol.PlaybackUpdate messages, want 1`. The reducer ignores playback messages so far. (Tests that assert *no* output, such as `TestCommandsWithoutVideoAreIgnored`, already pass.)

- [ ] **Step 3: Write the playback logic**

`server/internal/room/playback.go`:

```go
package room

import "popcorn/internal/protocol"

func (r *reducer) playback(id string, m protocol.ClientMsg) {
	switch m := m.(type) {
	case protocol.PlaybackLoad:
		r.setPlayback(protocol.PlaybackState{VideoID: protocol.Ptr(m.VideoID), UpdatedAt: r.now.UnixMilli()})
	case protocol.PlaybackPlay:
		r.command(m.Position, true)
	case protocol.PlaybackPause:
		r.command(m.Position, false)
	case protocol.PlaybackSeek:
		r.command(m.Position, r.s.Playback.Playing)
	case protocol.PlaybackStalled:
		if r.s.Playback.Playing {
			r.autoPause(id)
		}
	case protocol.PlaybackReady:
		r.ready(id)
	}
}

func (r *reducer) setPlayback(pb protocol.PlaybackState) {
	r.s.Playback = pb
	r.broadcast(protocol.PlaybackUpdate{State: pb})
}

// command applies a manual play, pause or seek. It always clears the waiting
// state: a person acting on purpose overrides an auto-pause.
func (r *reducer) command(position float64, playing bool) {
	if r.s.Playback.VideoID == nil {
		return
	}
	pb := r.s.Playback
	pb.Position, pb.Playing, pb.UpdatedAt = position, playing, r.now.UnixMilli()
	pb.WaitingFor, pb.AutoResume = nil, false
	r.setPlayback(pb)
}

// autoPause stops playback where it should be right now and waits for id.
func (r *reducer) autoPause(id string) {
	pb := r.s.Playback
	pb.Position = ExpectedPosition(pb, r.now)
	pb.Playing, pb.UpdatedAt = false, r.now.UnixMilli()
	pb.WaitingFor, pb.AutoResume = protocol.Ptr(id), true
	r.setPlayback(pb)
}

func (r *reducer) ready(id string) {
	pb := r.s.Playback
	if pb.Playing || !pb.AutoResume || pb.WaitingFor == nil || *pb.WaitingFor != id {
		return
	}
	pb.Playing, pb.UpdatedAt = true, r.now.UnixMilli()
	pb.WaitingFor, pb.AutoResume = nil, false
	r.setPlayback(pb)
}

// stopWaitingFor gives up on someone who has left: the room stays paused.
func (r *reducer) stopWaitingFor(id string) {
	pb := r.s.Playback
	if pb.WaitingFor == nil || *pb.WaitingFor != id {
		return
	}
	pb.WaitingFor, pb.AutoResume = nil, false
	r.setPlayback(pb)
}
```

- [ ] **Step 4: Route playback messages in `message`**

In `server/internal/room/reducer.go`, in `func (r *reducer) message`, add `id := r.s.Participants[i].ID` just before the `switch`, and add a playback case after the `protocol.Leave` case. The end of the function becomes:

```go
	id := r.s.Participants[i].ID
	switch m := ev.Msg.(type) {
	case protocol.Hello:
		r.send(ev.ConnID, badMessage("already joined"))
	case protocol.Ping:
		r.send(ev.ConnID, protocol.Pong{T0: m.T0, ServerTime: r.now.UnixMilli()})
	case protocol.Leave:
		r.remove(i)
		r.closeConn(ev.ConnID, nil, protocol.CloseNormal)
	case protocol.PlaybackLoad, protocol.PlaybackPlay, protocol.PlaybackPause,
		protocol.PlaybackSeek, protocol.PlaybackStalled, protocol.PlaybackReady:
		r.playback(id, m)
	}
}
```

- [ ] **Step 5: Auto-pause on disconnect**

In `server/internal/room/reducer.go`, replace the whole `disconnect` function with:

```go
func (r *reducer) disconnect(connID uint64) {
	i := r.s.byConn(connID)
	if i < 0 {
		return
	}
	p := &r.s.Participants[i]
	p.ConnID, p.DisconnectedAt = 0, r.now
	id := p.ID
	r.toOthers(id, protocol.ParticipantReconnecting{ID: id})
	if r.s.Playback.Playing {
		r.autoPause(id)
	}
}
```

- [ ] **Step 6: Stop waiting for someone who has gone**

In `server/internal/room/reducer.go`, in `remove`, add `r.stopWaitingFor(p.ID)` right after the `ParticipantLeft` broadcast:

```go
	r.broadcast(protocol.ParticipantLeft{ID: p.ID})
	r.stopWaitingFor(p.ID)
	if len(r.s.Participants) == 0 {
```

- [ ] **Step 7: Run all room tests**

Run: `go -C server test -race ./internal/room/`
Expected: `ok  popcorn/internal/room`.

- [ ] **Step 8: Commit**

```bash
git add server/internal/room
git commit -m "feat(server): authoritative playback with stall auto-pause and resume"
```

---

### Task 6: Cams, cursors, ink and signaling in the reducer

**Files:**
- Create: `server/internal/room/stage.go`
- Modify: `server/internal/room/reducer.go` (`message`, `disconnect`, `remove`)
- Test: `server/internal/room/stage_test.go`

**Interfaces:**
- Consumes: the reducer from Tasks 4 and 5, `ClampCamRect`, `InkWidth` and the `Max*` caps from Task 3, and the protocol cam, cursor, ink and signal messages.
- Produces: the reducer methods `camGrab`, `camMove(id, camID string, rect protocol.Rect, release bool)`, `releaseCamsHeldBy(id string)`, `inkPoints(p Participant, m protocol.InkPoints)`, `addSticky`, `trimSticky` and `inkClear(id string)`.
- Behavior:
  - Relayed messages (cursor, ink, signal) go to the partner only, with `from` set.
  - `cam` updates and `ink.clear` go to both people.

- [ ] **Step 1: Write the failing tests**

`server/internal/room/stage_test.go`:

```go
package room

import (
	"encoding/json"
	"fmt"
	"testing"

	"popcorn/internal/protocol"
)

func pairRoom(t *testing.T) *harness {
	h := newHarness(t)
	h.join(1)
	h.join(2)
	return h
}

func TestGrabTakesOverFromHolder(t *testing.T) {
	h := pairRoom(t)
	out := h.send(1, protocol.CamGrab{CamID: "p2"})
	for _, conn := range []uint64{1, 2} {
		if c := one[protocol.CamUpdate](t, out, conn); *c.Holder != "p1" {
			t.Errorf("conn %d got %+v", conn, c)
		}
	}
	out = h.send(2, protocol.CamGrab{CamID: "p2"})
	if c := one[protocol.CamUpdate](t, out, 1); *c.Holder != "p2" {
		t.Errorf("takeover: %+v", c)
	}
}

func TestOnlyHolderCanMoveOrRelease(t *testing.T) {
	h := pairRoom(t)
	h.send(1, protocol.CamGrab{CamID: "p1"})
	if out := h.send(2, protocol.CamMove{CamID: "p1", Rect: protocol.Rect{X: 0.5, Y: 0.5, W: 0.2, H: 0.2}}); len(out) != 0 {
		t.Errorf("move from non-holder produced %+v", out)
	}
	if out := h.send(2, protocol.CamRelease{CamID: "p1", Rect: protocol.Rect{X: 0.5, Y: 0.5, W: 0.2, H: 0.2}}); len(out) != 0 {
		t.Errorf("release from non-holder produced %+v", out)
	}
	out := h.send(1, protocol.CamMove{CamID: "p1", Rect: protocol.Rect{X: 0.95, Y: 0.1, W: 0.2, H: 0.2}})
	if c := one[protocol.CamUpdate](t, out, 2); !rectApprox(c.Rect, protocol.Rect{X: 0.8, Y: 0.1, W: 0.2, H: 0.2}) || *c.Holder != "p1" {
		t.Errorf("move should be clamped: %+v", c)
	}
	out = h.send(1, protocol.CamRelease{CamID: "p1", Rect: protocol.Rect{X: 0.3, Y: 0.3, W: 0.01, H: 0.01}})
	c := one[protocol.CamUpdate](t, out, 2)
	if c.Holder != nil || !rectApprox(c.Rect, protocol.Rect{X: 0.3, Y: 0.3, W: 0.08, H: 0.08}) {
		t.Errorf("release: %+v", c)
	}
	if h.s.Cams["p1"].Holder != nil {
		t.Error("holder should be cleared")
	}
}

func TestHolderDisconnectReleasesCam(t *testing.T) {
	h := pairRoom(t)
	h.send(2, protocol.CamGrab{CamID: "p1"})
	out := h.apply(DisconnectEvent{ConnID: 2})
	if c := one[protocol.CamUpdate](t, out, 1); c.CamID != "p1" || c.Holder != nil {
		t.Errorf("got %+v", c)
	}
}

func TestGrabUnknownCamIsIgnored(t *testing.T) {
	h := pairRoom(t)
	if out := h.send(1, protocol.CamGrab{CamID: "nope"}); len(out) != 0 {
		t.Errorf("got %+v", out)
	}
}

func TestCursorGoesOnlyToPartner(t *testing.T) {
	h := pairRoom(t)
	out := h.send(1, protocol.Cursor{X: 0.25, Y: 0.5})
	if c := one[protocol.CursorRelay](t, out, 2); c.From != "p1" || c.X != 0.25 || c.Y != 0.5 {
		t.Errorf("got %+v", c)
	}
	none(t, out, 1)
	one[protocol.CursorHideRelay](t, h.send(1, protocol.CursorHide{}), 2)
	h.apply(DisconnectEvent{ConnID: 2})
	if out := h.send(1, protocol.Cursor{X: 0.1, Y: 0.1}); len(out) != 0 {
		t.Errorf("cursor to a disconnected partner: %+v", out)
	}
}

func ink(stroke, mode string, n int) protocol.InkPoints {
	pts := make([]protocol.Point, n)
	for i := range pts {
		pts[i] = protocol.Point{0.5, 0.5}
	}
	return protocol.InkPoints{StrokeID: stroke, Mode: mode, Color: "#ffffff", Width: 0.5, Points: pts}
}

func TestFadingInkIsRelayedNotStored(t *testing.T) {
	h := pairRoom(t)
	out := h.send(1, ink("s1", protocol.InkFading, 3))
	rel := one[protocol.InkPointsRelay](t, out, 2)
	if rel.From != "p1" || rel.Color != "#112233" || rel.Width != InkWidth || len(rel.Points) != 3 {
		t.Errorf("server must set color and width: %+v", rel)
	}
	none(t, out, 1)
	if len(h.s.Sticky) != 0 {
		t.Errorf("fading ink was stored: %+v", h.s.Sticky)
	}
	if e := one[protocol.InkEndRelay](t, h.send(1, protocol.InkEnd{StrokeID: "s1"}), 2); e.StrokeID != "s1" {
		t.Errorf("got %+v", e)
	}
}

func TestStickyInkIsStoredAcrossBatches(t *testing.T) {
	h := pairRoom(t)
	h.send(1, ink("s1", protocol.InkSticky, 3))
	h.send(1, ink("s1", protocol.InkSticky, 2))
	h.send(2, ink("s1", protocol.InkSticky, 1)) // same ID, different author
	if len(h.s.Sticky) != 2 || len(h.s.Sticky[0].Points) != 5 || h.s.Sticky[1].Author != "p2" {
		t.Fatalf("sticky = %+v", h.s.Sticky)
	}
	w := one[protocol.Welcome](t, h.hello(3, "tok-p1"), 3)
	if len(w.Snapshot.StickyStrokes) != 2 {
		t.Errorf("snapshot strokes = %+v", w.Snapshot.StickyStrokes)
	}
}

func TestStrokeIsCappedAtMaxPoints(t *testing.T) {
	h := pairRoom(t)
	h.send(1, ink("s1", protocol.InkSticky, MaxStrokePoints-10))
	h.send(1, ink("s1", protocol.InkSticky, 64))
	if n := len(h.s.Sticky[0].Points); n != MaxStrokePoints {
		t.Errorf("stroke has %d points, want %d", n, MaxStrokePoints)
	}
}

func TestStickyStrokeCapDropsOldest(t *testing.T) {
	h := pairRoom(t)
	for i := range MaxStickyStrokes + 1 {
		h.send(1, ink(fmt.Sprintf("s%d", i), protocol.InkSticky, 1))
	}
	if len(h.s.Sticky) != MaxStickyStrokes || h.s.Sticky[0].ID != "s1" {
		t.Errorf("got %d strokes, first %s", len(h.s.Sticky), h.s.Sticky[0].ID)
	}
}

func TestStickyPointCapKeepsWelcomeSmall(t *testing.T) {
	h := pairRoom(t)
	strokes := MaxStickyPoints/MaxStrokePoints + 1
	for i := range strokes {
		h.send(1, ink(fmt.Sprintf("s%d", i), protocol.InkSticky, MaxStrokePoints))
	}
	if h.s.stickyPoints > MaxStickyPoints || h.s.Sticky[0].ID != "s1" {
		t.Fatalf("points = %d, first stroke %s", h.s.stickyPoints, h.s.Sticky[0].ID)
	}
	w := one[protocol.Welcome](t, h.hello(3, "tok-p1"), 3)
	b, _ := json.Marshal(w)
	if len(b) > 4<<20 {
		t.Errorf("welcome is %d bytes", len(b))
	}
}

func TestClearEmptiesStickyForBoth(t *testing.T) {
	h := pairRoom(t)
	h.send(1, ink("s1", protocol.InkSticky, 3))
	out := h.send(2, protocol.InkClear{})
	for _, conn := range []uint64{1, 2} {
		if c := one[protocol.InkClearRelay](t, out, conn); c.From != "p2" {
			t.Errorf("conn %d got %+v", conn, c)
		}
	}
	if len(h.s.Sticky) != 0 || h.s.stickyPoints != 0 {
		t.Errorf("sticky = %+v", h.s.Sticky)
	}
}

func TestSignalOnlyWhenBothConnected(t *testing.T) {
	h := pairRoom(t)
	data := json.RawMessage(`{"candidate":null}`)
	if s := one[protocol.SignalRelay](t, h.send(1, protocol.Signal{Data: data}), 2); s.From != "p1" || string(s.Data) != string(data) {
		t.Errorf("got %+v", s)
	}
	h.apply(DisconnectEvent{ConnID: 2})
	if out := h.send(1, protocol.Signal{Data: data}); len(out) != 0 {
		t.Errorf("signal to a disconnected partner: %+v", out)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/room/`
Expected: FAIL with messages like `conn 1 got 0 protocol.CamUpdate messages, want 1`. Some sticky-ink tests panic with `index out of range`, because nothing is stored yet.

- [ ] **Step 3: Write the stage logic**

`server/internal/room/stage.go`:

```go
package room

import (
	"maps"
	"slices"

	"popcorn/internal/protocol"
)

// camGrab: last grab wins, even if the other person is mid-drag.
func (r *reducer) camGrab(id, camID string) {
	cam, ok := r.s.Cams[camID]
	if !ok {
		return
	}
	cam.Holder = protocol.Ptr(id)
	r.s.Cams[camID] = cam
	r.broadcast(protocol.CamUpdate{CamID: camID, Rect: cam.Rect, Holder: cam.Holder})
}

// camMove handles cam.move and, with release set, cam.release. Both are
// ignored unless the sender holds the cam.
func (r *reducer) camMove(id, camID string, rect protocol.Rect, release bool) {
	cam, ok := r.s.Cams[camID]
	if !ok || cam.Holder == nil || *cam.Holder != id {
		return
	}
	cam.Rect = ClampCamRect(rect)
	if release {
		cam.Holder = nil
	}
	r.s.Cams[camID] = cam
	r.broadcast(protocol.CamUpdate{CamID: camID, Rect: cam.Rect, Holder: cam.Holder})
}

func (r *reducer) releaseCamsHeldBy(id string) {
	for _, camID := range slices.Sorted(maps.Keys(r.s.Cams)) {
		cam := r.s.Cams[camID]
		if cam.Holder != nil && *cam.Holder == id {
			cam.Holder = nil
			r.s.Cams[camID] = cam
			r.broadcast(protocol.CamUpdate{CamID: camID, Rect: cam.Rect})
		}
	}
}

// inkPoints relays a batch to the partner. The server decides color and
// width. Sticky batches are also stored for the snapshot.
func (r *reducer) inkPoints(p Participant, m protocol.InkPoints) {
	r.toOthers(p.ID, protocol.InkPointsRelay{
		From: p.ID, StrokeID: m.StrokeID, Mode: m.Mode, Color: p.Color, Width: InkWidth, Points: m.Points,
	})
	if m.Mode == protocol.InkSticky {
		r.addSticky(p, m)
	}
}

func (r *reducer) addSticky(p Participant, m protocol.InkPoints) {
	i := slices.IndexFunc(r.s.Sticky, func(st protocol.Stroke) bool {
		return st.ID == m.StrokeID && st.Author == p.ID
	})
	if i < 0 {
		r.s.Sticky = append(r.s.Sticky, protocol.Stroke{ID: m.StrokeID, Author: p.ID, Color: p.Color, Width: InkWidth})
		i = len(r.s.Sticky) - 1
	}
	st := &r.s.Sticky[i]
	pts := m.Points[:min(len(m.Points), max(MaxStrokePoints-len(st.Points), 0))]
	st.Points = append(st.Points, pts...)
	r.s.stickyPoints += len(pts)
	r.trimSticky()
}

// trimSticky drops the oldest strokes until both caps are met.
func (r *reducer) trimSticky() {
	drop := 0
	for len(r.s.Sticky)-drop > MaxStickyStrokes || r.s.stickyPoints > MaxStickyPoints {
		r.s.stickyPoints -= len(r.s.Sticky[drop].Points)
		drop++
	}
	if drop > 0 {
		r.s.Sticky = slices.Clone(r.s.Sticky[drop:])
	}
}

func (r *reducer) inkClear(id string) {
	r.s.Sticky, r.s.stickyPoints = nil, 0
	r.broadcast(protocol.InkClearRelay{From: id})
}
```

- [ ] **Step 4: Route stage messages in `message`**

In `server/internal/room/reducer.go`, in `func (r *reducer) message`, add these cases after the playback case, before the closing brace of the `switch`:

```go
	case protocol.CamGrab:
		r.camGrab(id, m.CamID)
	case protocol.CamMove:
		r.camMove(id, m.CamID, m.Rect, false)
	case protocol.CamRelease:
		r.camMove(id, m.CamID, m.Rect, true)
	case protocol.Cursor:
		r.toOthers(id, protocol.CursorRelay{From: id, X: m.X, Y: m.Y})
	case protocol.CursorHide:
		r.toOthers(id, protocol.CursorHideRelay{From: id})
	case protocol.InkPoints:
		r.inkPoints(r.s.Participants[i], m)
	case protocol.InkEnd:
		r.toOthers(id, protocol.InkEndRelay{From: id, StrokeID: m.StrokeID})
	case protocol.InkClear:
		r.inkClear(id)
	case protocol.Signal:
		// toOthers skips a disconnected partner, so signals only flow while
		// both people are connected.
		r.toOthers(id, protocol.SignalRelay{From: id, Data: m.Data})
```

- [ ] **Step 5: Release held cams on disconnect and on removal**

In `server/internal/room/reducer.go`, add `r.releaseCamsHeldBy(id)` as the last line of `disconnect`:

```go
	if r.s.Playback.Playing {
		r.autoPause(id)
	}
	r.releaseCamsHeldBy(id)
}
```

In `remove`, add `r.releaseCamsHeldBy(p.ID)` after `r.stopWaitingFor(p.ID)`:

```go
	r.broadcast(protocol.ParticipantLeft{ID: p.ID})
	r.stopWaitingFor(p.ID)
	r.releaseCamsHeldBy(p.ID)
	if len(r.s.Participants) == 0 {
```

- [ ] **Step 6: Run all room tests**

Run: `go -C server test -race ./internal/room/`
Expected: `ok  popcorn/internal/room`.

- [ ] **Step 7: Commit**

```bash
git add server/internal/room
git commit -m "feat(server): cam holding, cursor relay, fading and sticky ink, signaling"
```

---

### Task 7: Hub goroutine and room registry

**Files:**
- Create: `server/internal/room/hub.go`, `server/internal/room/registry.go`
- Test: `server/internal/room/hub_test.go`

**Interfaces:**
- Consumes: `Apply`, `NewRoomState`, `NewRoomID`, `protocol.Encode`.
- Produces:
  - **`Conn` interface:** `ID() uint64`, `Enqueue([]byte) bool` (non-blocking; false means the queue is full), `Close(code int)` (flush, then close), `Kill()`.
  - **`HubConfig{TickEvery time.Duration; Now func() time.Time; Logger *slog.Logger}`.** Zero values mean 1 s, `time.Now` and `slog.Default()`.
  - **`*Hub` methods:**
    - `Join(c Conn, ev HelloEvent) bool`
    - `Message(connID uint64, m protocol.ClientMsg) bool`
    - `Disconnect(connID uint64)`
    - `Deliver(connID uint64, m protocol.Message)`
    - `Join` and `Message` return false once the room has expired.
  - **`Registry`:**
    - `NewRegistry(cfg HubConfig, maxRooms int) *Registry`
    - `(*Registry) Create() (string, error)`, which returns `ErrTooManyRooms` at the cap
    - `Get(id string) (*Hub, bool)`
    - `Len() int`
  - **Test helpers in `hub_test.go`:** `fakeConn`, `fakeClock`, `eventually`.

- [ ] **Step 1: Write the failing tests**

`server/internal/room/hub_test.go`:

```go
package room

import (
	"errors"
	"sync"
	"testing"
	"time"

	"popcorn/internal/protocol"
)

type fakeConn struct {
	id uint64

	mu         sync.Mutex
	msgs       []protocol.Message
	full       bool
	closedWith int
	killed     bool
}

func (c *fakeConn) ID() uint64 { return c.id }

func (c *fakeConn) Enqueue(b []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.full {
		return false
	}
	m, err := protocol.DecodeServer(b)
	if err != nil {
		panic(err)
	}
	c.msgs = append(c.msgs, m)
	return true
}

func (c *fakeConn) Close(code int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closedWith = code
}

func (c *fakeConn) Kill() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.killed = true
}

func (c *fakeConn) setFull() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.full = true
}

func received[T protocol.Message](c *fakeConn) []T {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []T
	for _, m := range c.msgs {
		if v, ok := m.(T); ok {
			out = append(out, v)
		}
	}
	return out
}

func (c *fakeConn) status() (closedWith int, killed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closedWith, c.killed
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func helloEvent(name string) HelloEvent {
	return HelloEvent{
		Hello:    protocol.Hello{Name: name, Color: "#112233", PageSession: "ps-" + name},
		NewID:    NewParticipantID(),
		NewToken: NewResumeToken(),
	}
}

func startHub(t *testing.T) *Hub {
	h := newHub("room", HubConfig{TickEvery: 5 * time.Millisecond}, func() {})
	go h.run()
	return h
}

func TestHubRoutesMessagesBetweenConnections(t *testing.T) {
	h := startHub(t)
	a, b := &fakeConn{id: 1}, &fakeConn{id: 2}
	h.Join(a, helloEvent("a"))
	h.Join(b, helloEvent("b"))
	eventually(t, "both welcomed", func() bool {
		return len(received[protocol.Welcome](a)) == 1 && len(received[protocol.Welcome](b)) == 1
	})
	h.Message(1, protocol.Cursor{X: 0.5, Y: 0.5})
	eventually(t, "cursor relayed", func() bool { return len(received[protocol.CursorRelay](b)) == 1 })
	if n := len(received[protocol.CursorRelay](a)); n != 0 {
		t.Errorf("sender got its own cursor %d times", n)
	}
}

func TestHubDropsSlowConnection(t *testing.T) {
	h := startHub(t)
	a, b := &fakeConn{id: 1}, &fakeConn{id: 2}
	h.Join(a, helloEvent("a"))
	h.Join(b, helloEvent("b"))
	eventually(t, "b welcomed", func() bool { return len(received[protocol.Welcome](b)) == 1 })
	b.setFull()
	h.Message(1, protocol.Cursor{X: 0.5, Y: 0.5})
	eventually(t, "b killed", func() bool { _, killed := b.status(); return killed })
	eventually(t, "a told b is reconnecting", func() bool {
		return len(received[protocol.ParticipantReconnecting](a)) == 1
	})
}

func TestHubClosesRejectedConnection(t *testing.T) {
	h := startHub(t)
	a, b, c := &fakeConn{id: 1}, &fakeConn{id: 2}, &fakeConn{id: 3}
	h.Join(a, helloEvent("a"))
	h.Join(b, helloEvent("b"))
	h.Join(c, helloEvent("c"))
	eventually(t, "c closed", func() bool { code, _ := c.status(); return code == protocol.CloseRoomFull })
	if errs := received[protocol.ErrorMsg](c); len(errs) != 1 || errs[0].Code != protocol.CodeRoomFull {
		t.Errorf("errors = %+v", errs)
	}
}

func TestRegistryRemovesExpiredRoom(t *testing.T) {
	clock := &fakeClock{now: t0}
	reg := NewRegistry(HubConfig{TickEvery: 5 * time.Millisecond, Now: clock.Now}, 10)
	id, err := reg.Create()
	if err != nil {
		t.Fatal(err)
	}
	h, ok := reg.Get(id)
	if !ok {
		t.Fatal("room not found right after Create")
	}
	clock.Advance(EmptyRoomTTL)
	eventually(t, "room removed", func() bool { _, ok := reg.Get(id); return !ok })
	if h.Message(1, protocol.Ping{}) {
		t.Error("an expired hub accepted a message")
	}
}

func TestRegistryCapsRoomCount(t *testing.T) {
	reg := NewRegistry(HubConfig{}, 2)
	for range 2 {
		if _, err := reg.Create(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := reg.Create(); !errors.Is(err, ErrTooManyRooms) {
		t.Errorf("err = %v, want ErrTooManyRooms", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/room/`
Expected: FAIL to compile with `undefined: newHub`, `undefined: HubConfig`, `undefined: NewRegistry`.

- [ ] **Step 3: Write the hub**

`server/internal/room/hub.go`. The `events` channel is **unbuffered on purpose**. A buffered channel would let `select` accept a send after the room expired, because Go picks randomly when both the send and `<-done` are ready. With an unbuffered channel, a send only succeeds while `run` is receiving.

```go
package room

import (
	"log/slog"
	"time"

	"popcorn/internal/protocol"
)

// Conn is the hub's view of one WebSocket connection. The hub never blocks
// on a Conn, so one slow browser can't stall the room.
type Conn interface {
	ID() uint64
	// Enqueue queues an encoded message without blocking. It returns false if
	// the outbound queue is full.
	Enqueue(msg []byte) bool
	// Close sends whatever is queued, then closes with the given status code.
	Close(code int)
	// Kill drops the connection immediately.
	Kill()
}

type HubConfig struct {
	TickEvery time.Duration    // default 1s
	Now       func() time.Time // default time.Now
	Logger    *slog.Logger     // default slog.Default()
}

func (c HubConfig) withDefaults() HubConfig {
	if c.TickEvery == 0 {
		c.TickEvery = time.Second
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	return c
}

// Hub is one room's goroutine. It owns the room state and the room's
// connections; everything else talks to it through its methods, which queue
// work onto the goroutine. No locks are needed.
type Hub struct {
	id       string
	cfg      HubConfig
	events   chan func()
	done     chan struct{}
	onExpire func()

	// Owned by the run goroutine.
	state RoomState
	conns map[uint64]Conn
}

func newHub(id string, cfg HubConfig, onExpire func()) *Hub {
	cfg = cfg.withDefaults()
	return &Hub{
		id:       id,
		cfg:      cfg,
		events:   make(chan func()), // unbuffered: a send succeeds only while run is live
		done:     make(chan struct{}),
		onExpire: onExpire,
		state:    NewRoomState(cfg.Now()),
		conns:    map[uint64]Conn{},
	}
}

func (h *Hub) run() {
	ticker := time.NewTicker(h.cfg.TickEvery)
	defer ticker.Stop()
	for !h.state.Expired {
		select {
		case f := <-h.events:
			f()
		case <-ticker.C:
			h.apply(TickEvent{})
		}
	}
	close(h.done)
	for _, c := range h.conns {
		c.Kill()
	}
	h.onExpire()
}

// do queues f onto the hub goroutine. It returns false if the room has
// expired.
func (h *Hub) do(f func()) bool {
	select {
	case h.events <- f:
		return true
	case <-h.done:
		return false
	}
}

// Join registers c and processes its hello. ev.ConnID is filled in from c.
func (h *Hub) Join(c Conn, ev HelloEvent) bool {
	return h.do(func() {
		h.conns[c.ID()] = c
		ev.ConnID = c.ID()
		h.apply(ev)
	})
}

// Message processes a message from a joined connection.
func (h *Hub) Message(connID uint64, m protocol.ClientMsg) bool {
	return h.do(func() { h.apply(MessageEvent{ConnID: connID, Msg: m}) })
}

// Disconnect tells the hub a connection has gone. Safe to call more than once.
func (h *Hub) Disconnect(connID uint64) {
	h.do(func() {
		delete(h.conns, connID)
		h.apply(DisconnectEvent{ConnID: connID})
	})
}

// Deliver sends m straight to one connection, bypassing room logic. Used for
// errors the connection detects itself, like rate limiting.
func (h *Hub) Deliver(connID uint64, m protocol.Message) {
	h.do(func() { h.dispatch(Outbound{ConnID: connID, Msg: m}) })
}

func (h *Hub) apply(ev Event) {
	var out []Outbound
	h.state, out = Apply(h.state, ev, h.cfg.Now())
	for _, o := range out {
		h.dispatch(o)
	}
}

// dispatch encodes on the hub goroutine, so the bytes never alias room state
// that a later event might change.
func (h *Hub) dispatch(o Outbound) {
	c, ok := h.conns[o.ConnID]
	if !ok {
		return
	}
	if o.Msg != nil {
		b, err := protocol.Encode(o.Msg)
		if err != nil {
			h.cfg.Logger.Error("encode failed", "room", h.id, "type", o.Msg.MsgType(), "err", err)
			return
		}
		if !c.Enqueue(b) {
			h.cfg.Logger.Warn("dropping slow connection", "room", h.id, "conn", c.ID())
			delete(h.conns, c.ID())
			c.Kill()
			h.apply(DisconnectEvent{ConnID: c.ID()})
			return
		}
	}
	if o.Close != 0 {
		delete(h.conns, o.ConnID)
		c.Close(o.Close)
	}
}
```

- [ ] **Step 4: Write the registry**

`server/internal/room/registry.go`:

```go
package room

import (
	"errors"
	"sync"
)

var ErrTooManyRooms = errors.New("too many rooms")

// Registry maps room IDs to hubs. A hub removes itself when its room expires.
type Registry struct {
	cfg      HubConfig
	maxRooms int

	mu   sync.Mutex
	hubs map[string]*Hub
}

func NewRegistry(cfg HubConfig, maxRooms int) *Registry {
	return &Registry{cfg: cfg, maxRooms: maxRooms, hubs: map[string]*Hub{}}
}

// Create starts a new room and returns its ID.
func (r *Registry) Create() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.hubs) >= r.maxRooms {
		return "", ErrTooManyRooms
	}
	id := NewRoomID()
	h := newHub(id, r.cfg, func() { r.remove(id) })
	r.hubs[id] = h
	go h.run()
	return id, nil
}

func (r *Registry) Get(id string) (*Hub, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, ok := r.hubs[id]
	return h, ok
}

func (r *Registry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.hubs)
}

func (r *Registry) remove(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.hubs, id)
}
```

- [ ] **Step 5: Run the tests to verify they pass, repeatedly**

Run: `go -C server test -race -count=10 ./internal/room/`
Expected: `ok  popcorn/internal/room`. "dropping slow connection" warnings in the output are expected. Running ten times shakes out timing flakes.

- [ ] **Step 6: Commit**

```bash
git add server/internal/room
git commit -m "feat(server): per-room hub goroutine and registry with expiry"
```

---

### Task 8: TURN credentials

**Files:**
- Create: `server/internal/turn/turn.go`
- Test: `server/internal/turn/turn_test.go`

**Interfaces:**
- Consumes: `protocol.IceServer`.
- Produces (package `popcorn/internal/turn`):
  - **`Provider` interface:** `ICEServers(ctx context.Context) ([]protocol.IceServer, error)`.
  - **`DefaultSTUN []protocol.IceServer`.**
  - **`Static []protocol.IceServer`**, which implements `Provider`.
  - **`New(provider, keyID, apiToken string) (Provider, bool)`.** Returns ok = false when TURN isn't configured.
  - **`Cloudflare`:** `{KeyID, APIToken, BaseURL string; TTL time.Duration; HTTP *http.Client; Now func() time.Time}`.

- [ ] **Step 1: Write the failing tests**

`server/internal/turn/turn_test.go`:

```go
package turn

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const cloudflareReply = `{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]}`

func TestCloudflareFetchesAndCaches(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/v1/turn/keys/key123/credentials/generate-ice-servers" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("Authorization = %q", got)
		}
		var body struct {
			TTL int `json:"ttl"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TTL != 43200 {
			t.Errorf("body ttl = %d, err %v", body.TTL, err)
		}
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, cloudflareReply)
	}))
	defer srv.Close()

	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	cf := &Cloudflare{KeyID: "key123", APIToken: "secret", BaseURL: srv.URL, Now: func() time.Time { return now }}

	servers, err := cf.ICEServers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 2 || servers[1].Username != "u" || servers[1].Credential != "c" {
		t.Fatalf("servers = %+v", servers)
	}
	cf.ICEServers(context.Background())
	if n := calls.Load(); n != 1 {
		t.Errorf("second call within TTL/2 fetched again (%d calls)", n)
	}
	now = now.Add(6*time.Hour + time.Second)
	cf.ICEServers(context.Background())
	if n := calls.Load(); n != 2 {
		t.Errorf("call after TTL/2 should refetch (%d calls)", n)
	}
}

func TestCloudflareErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer srv.Close()
	cf := &Cloudflare{KeyID: "k", APIToken: "bad", BaseURL: srv.URL}
	_, err := cf.ICEServers(context.Background())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("err = %v, want one mentioning 401", err)
	}
}

func TestNew(t *testing.T) {
	if p, ok := New("cloudflare", "k", "t"); !ok {
		t.Error("cloudflare with credentials should be configured")
	} else if _, isCF := p.(*Cloudflare); !isCF {
		t.Errorf("got %T", p)
	}
	for _, args := range [][3]string{{"", "", ""}, {"cloudflare", "", "t"}, {"metered", "k", "t"}} {
		p, ok := New(args[0], args[1], args[2])
		if ok {
			t.Errorf("New%v should not be configured", args)
		}
		servers, _ := p.ICEServers(context.Background())
		if len(servers) == 0 || !strings.HasPrefix(servers[0].URLs[0], "stun:") {
			t.Errorf("New%v fallback = %+v", args, servers)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/turn/`
Expected: FAIL to compile with `undefined: Cloudflare`, `undefined: New`.

- [ ] **Step 3: Write the provider**

`server/internal/turn/turn.go`. The API is Cloudflare Realtime TURN. `POST /v1/turn/keys/{keyId}/credentials/generate-ice-servers` with a bearer token and `{"ttl":…}` returns `201 {"iceServers":[…]}`. The documentation is at https://developers.cloudflare.com/realtime/turn/generate-credentials/.

```go
// Package turn supplies the ICE servers sent to browsers in welcome. The
// provider's API key stays on the server; browsers only ever see short-lived
// credentials.
package turn

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"popcorn/internal/protocol"
)

type Provider interface {
	ICEServers(ctx context.Context) ([]protocol.IceServer, error)
}

// DefaultSTUN is used when TURN isn't configured or a credential fetch fails.
var DefaultSTUN = []protocol.IceServer{
	{URLs: []string{"stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"}},
}

// Static always returns the same servers.
type Static []protocol.IceServer

func (s Static) ICEServers(context.Context) ([]protocol.IceServer, error) { return s, nil }

// New returns the configured provider. If TURN isn't configured it returns
// STUN only and ok == false, so the caller can log a warning.
func New(provider, keyID, apiToken string) (p Provider, ok bool) {
	if provider == "cloudflare" && keyID != "" && apiToken != "" {
		return &Cloudflare{KeyID: keyID, APIToken: apiToken}, true
	}
	return Static(DefaultSTUN), false
}

const defaultCloudflareURL = "https://rtc.live.cloudflare.com"

// Cloudflare fetches credentials from Cloudflare Realtime TURN. One set of
// credentials is shared by every join until half its TTL has passed.
type Cloudflare struct {
	KeyID    string
	APIToken string
	BaseURL  string           // default https://rtc.live.cloudflare.com
	TTL      time.Duration    // default 12h
	HTTP     *http.Client     // default http.DefaultClient
	Now      func() time.Time // default time.Now

	mu      sync.Mutex
	cached  []protocol.IceServer
	expires time.Time
}

func (c *Cloudflare) ICEServers(ctx context.Context) ([]protocol.IceServer, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.cached != nil && now.Before(c.expires) {
		return c.cached, nil
	}
	servers, err := c.fetch(ctx)
	if err != nil {
		return nil, err
	}
	c.cached, c.expires = servers, now.Add(c.ttl()/2)
	return servers, nil
}

func (c *Cloudflare) fetch(ctx context.Context) ([]protocol.IceServer, error) {
	endpoint := c.baseURL() + "/v1/turn/keys/" + url.PathEscape(c.KeyID) + "/credentials/generate-ice-servers"
	body := fmt.Sprintf(`{"ttl":%d}`, int(c.ttl().Seconds()))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("turn: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("turn: cloudflare returned %s", resp.Status)
	}
	var out struct {
		IceServers []protocol.IceServer `json:"iceServers"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		return nil, fmt.Errorf("turn: decoding response: %w", err)
	}
	if len(out.IceServers) == 0 {
		return nil, fmt.Errorf("turn: cloudflare returned no ICE servers")
	}
	return out.IceServers, nil
}

func (c *Cloudflare) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return defaultCloudflareURL
}

func (c *Cloudflare) ttl() time.Duration {
	if c.TTL > 0 {
		return c.TTL
	}
	return 12 * time.Hour
}

func (c *Cloudflare) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Cloudflare) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go -C server test -race ./internal/turn/`
Expected: `ok  popcorn/internal/turn`.

- [ ] **Step 5: Commit**

```bash
git add server/internal/turn
git commit -m "feat(server): Cloudflare TURN credentials with caching and STUN fallback"
```

---

### Task 9: HTTP API (room creation and embedded frontend)

**Files:**
- Create: `server/internal/httpapi/server.go`, `server/internal/httpapi/static.go`
- Create: `server/internal/webdist/webdist.go`, `server/internal/webdist/dist/.gitkeep`
- Create: `.gitignore`
- Test: `server/internal/httpapi/server_test.go`

**Interfaces:**
- Consumes: `room.Registry` (`Create`), `turn.Provider`.
- Produces:
  - **`httpapi.Config{Registry *room.Registry; ICE turn.Provider; Static fs.FS; Logger *slog.Logger}`.**
  - **`httpapi.New(Config) http.Handler`**, with the routes `POST /api/rooms`, `GET /api/` (404) and `GET /` (SPA).
  - **`httpapi.Server`**, with the fields `reg`, `ice` and `log`. Task 10 adds methods to it.
  - **`webdist.FS() fs.FS`.**
  - **Test helpers:** `testStatic` and `newHandler(reg, static)`, both reused by Task 10.

- [ ] **Step 1: Write the failing tests**

`server/internal/httpapi/server_test.go`:

```go
package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"popcorn/internal/room"
	"popcorn/internal/turn"
)

var testStatic = fstest.MapFS{
	"index.html":        {Data: []byte("<!doctype html><title>Popcorn</title>")},
	"assets/app-abc.js": {Data: []byte("console.log(1)")},
}

func newHandler(reg *room.Registry, static fstest.MapFS) http.Handler {
	return New(Config{Registry: reg, ICE: turn.Static(turn.DefaultSTUN), Static: static})
}

func TestCreateRoom(t *testing.T) {
	reg := room.NewRegistry(room.HubConfig{}, 10)
	rec := httptest.NewRecorder()
	newHandler(reg, testStatic).ServeHTTP(rec, httptest.NewRequest("POST", "/api/rooms", nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var body struct {
		RoomID string `json:"roomId"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.RoomID) != 22 {
		t.Errorf("roomId %q should be 22 characters", body.RoomID)
	}
	if _, ok := reg.Get(body.RoomID); !ok {
		t.Error("room is not in the registry")
	}
}

func TestCreateRoomWhenFull(t *testing.T) {
	reg := room.NewRegistry(room.HubConfig{}, 1)
	reg.Create()
	rec := httptest.NewRecorder()
	newHandler(reg, testStatic).ServeHTTP(rec, httptest.NewRequest("POST", "/api/rooms", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", rec.Code)
	}
}

func TestStaticAndSPAFallback(t *testing.T) {
	h := newHandler(room.NewRegistry(room.HubConfig{}, 10), testStatic)
	cases := []struct {
		path, wantBody, wantCache string
		wantCode                  int
	}{
		{"/", "<!doctype html>", "no-cache", 200},
		{"/r/abc123", "<!doctype html>", "no-cache", 200},
		{"/assets/app-abc.js", "console.log", "immutable", 200},
		{"/assets/missing.js", "", "", 404},
		{"/api/rooms", "", "", 404},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", c.path, nil))
			if rec.Code != c.wantCode {
				t.Fatalf("status %d, want %d", rec.Code, c.wantCode)
			}
			body, _ := io.ReadAll(rec.Body)
			if !strings.Contains(string(body), c.wantBody) {
				t.Errorf("body %q missing %q", body, c.wantBody)
			}
			if !strings.Contains(rec.Header().Get("Cache-Control"), c.wantCache) {
				t.Errorf("Cache-Control %q missing %q", rec.Header().Get("Cache-Control"), c.wantCache)
			}
		})
	}
}

func TestUnbuiltFrontendExplainsItself(t *testing.T) {
	h := newHandler(room.NewRegistry(room.HubConfig{}, 10), fstest.MapFS{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "hasn't been built") {
		t.Errorf("status %d body %q", rec.Code, rec.Body)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/httpapi/`
Expected: FAIL to compile with `undefined: New`, `undefined: Config`.

- [ ] **Step 3: Write the server and routes**

`server/internal/httpapi/server.go`. Pattern note: Go's mux panics on conflicting patterns, and `"/api/"` without a method would conflict with `"GET /"`. That's why the catch-all is `"GET /api/"`.

```go
// Package httpapi is the server's HTTP surface: room creation, the WebSocket
// endpoint, and the embedded frontend.
package httpapi

import (
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"

	"popcorn/internal/room"
	"popcorn/internal/turn"
)

type Config struct {
	Registry *room.Registry
	ICE      turn.Provider
	Static   fs.FS // the built frontend; must contain index.html to be useful
	Logger   *slog.Logger
}

type Server struct {
	reg *room.Registry
	ice turn.Provider
	log *slog.Logger
}

func New(cfg Config) http.Handler {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{reg: cfg.Registry, ice: cfg.ICE, log: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", s.createRoom)
	mux.Handle("GET /api/", http.NotFoundHandler())
	mux.Handle("GET /", spa(cfg.Static))
	return mux
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	id, err := s.reg.Create()
	if err != nil {
		s.log.Warn("room not created", "err", err)
		http.Error(w, "Too many rooms right now. Try again later.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"roomId": id})
}
```

- [ ] **Step 4: Write the SPA handler**

`server/internal/httpapi/static.go`:

```go
package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spa serves the built frontend. A path that isn't a file and has no
// extension gets index.html, so client-side routes like /r/<id> work.
func spa(static fs.FS) http.Handler {
	files := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if info, err := fs.Stat(static, name); err == nil && !info.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					// Vite puts a content hash in every asset's filename.
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
		}
		serveIndex(w, static)
	})
}

func serveIndex(w http.ResponseWriter, static fs.FS) {
	page, err := fs.ReadFile(static, "index.html")
	if err != nil {
		http.Error(w, "The frontend hasn't been built yet.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(page)
}
```

- [ ] **Step 5: Add the embed package and ignore built files**

`server/internal/webdist/webdist.go`:

```go
// Package webdist embeds the built frontend. The build copies web/dist into
// ./dist; until then dist holds only .gitkeep and the server explains that
// the frontend hasn't been built.
package webdist

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err) // "dist" is a constant, valid path
	}
	return sub
}
```

```bash
mkdir -p server/internal/webdist/dist
touch server/internal/webdist/dist/.gitkeep
```

`.gitignore` (repo root):

```gitignore
# The built frontend is copied here for go:embed; only the placeholder is tracked.
/server/internal/webdist/dist/*
!/server/internal/webdist/dist/.gitkeep
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go -C server test -race ./internal/httpapi/ && go -C server vet ./...`
Expected: `ok  popcorn/internal/httpapi` and no output from `vet`.

- [ ] **Step 7: Commit**

```bash
git add .gitignore server/internal/httpapi server/internal/webdist
git commit -m "feat(server): room creation endpoint and embedded SPA serving"
```

---

### Task 10: WebSocket endpoint and two-client integration tests

**Files:**
- Create: `server/internal/httpapi/ws.go`
- Modify: `server/internal/httpapi/server.go` (add the `/ws` route), `server/go.mod`/`go.sum` (dependencies)
- Test: `server/internal/httpapi/ws_test.go`

**Interfaces:**
- Consumes:
  - `room.Hub` (`Join`, `Message`, `Disconnect`, `Deliver`) and `room.HelloEvent`
  - `room.NewParticipantID`, `room.NewResumeToken`
  - `turn.DefaultSTUN`
  - `protocol.DecodeClient`, `protocol.Encode`, `protocol.ErrorMsg`, and the `Code*`/`Close*` constants
  - `newHandler` and `testStatic` from Task 9's tests
- Produces:
  - **`(*Server) serveWS`** on `GET /ws?room=<id>`.
  - **`wsConn`**, which implements `room.Conn`.
  - **Constants** `maxMessageBytes`, `rateBurst` and others.
  - **Wire behavior:**
    - Unknown room → `error not_found`, then close 4404.
    - A bad or non-hello first message → `error bad_message`, then close 4400.
    - Over 16 KB → close 1009.
    - Server pings every 15 s.

- [ ] **Step 1: Add the dependencies**

```bash
go -C server get github.com/coder/websocket@v1.8.15 golang.org/x/time@v0.15.0
```

Expected: `go: added github.com/coder/websocket v1.8.15` and `go: added golang.org/x/time v0.15.0`. The `go` line in `go.mod` must stay at 1.25.x. If it changed, a newer version slipped in, so recheck the versions.

- [ ] **Step 2: Write the failing integration tests**

`server/internal/httpapi/ws_test.go`:

```go
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"popcorn/internal/protocol"
	"popcorn/internal/room"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(newHandler(room.NewRegistry(room.HubConfig{}, 100), testStatic))
	t.Cleanup(srv.Close)
	return srv
}

func createRoom(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	resp, err := http.Post(srv.URL+"/api/rooms", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		RoomID string `json:"roomId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.RoomID
}

type wsClient struct {
	t  *testing.T
	ws *websocket.Conn
}

func dial(t *testing.T, srv *httptest.Server, roomID string) *wsClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?room=" + roomID
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	return &wsClient{t: t, ws: ws}
}

func (c *wsClient) writeRaw(data []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *wsClient) send(m protocol.Message) {
	c.t.Helper()
	b, err := protocol.Encode(m)
	if err != nil {
		c.t.Fatal(err)
	}
	c.writeRaw(b)
}

func (c *wsClient) readRaw() ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.ws.Read(ctx)
	return data, err
}

func (c *wsClient) join(name, token string) protocol.Welcome {
	c.t.Helper()
	c.send(protocol.Hello{Name: name, Color: "#112233", PageSession: "ps-" + name, ResumeToken: token})
	return expect[protocol.Welcome](c)
}

// expect reads the next message and fails unless it is a T.
func expect[T protocol.Message](c *wsClient) T {
	c.t.Helper()
	data, err := c.readRaw()
	if err != nil {
		c.t.Fatalf("waiting for %T: %v", *new(T), err)
	}
	m, err := protocol.DecodeServer(data)
	if err != nil {
		c.t.Fatalf("decode %s: %v", data, err)
	}
	v, ok := m.(T)
	if !ok {
		c.t.Fatalf("got %s, want %T", data, *new(T))
	}
	return v
}

func expectClose(c *wsClient, code int) {
	c.t.Helper()
	data, err := c.readRaw()
	if err == nil {
		c.t.Fatalf("got message %s, want close %d", data, code)
	}
	if got := int(websocket.CloseStatus(err)); got != code {
		c.t.Fatalf("close status %d, want %d (err: %v)", got, code, err)
	}
}

type pair struct {
	srv    *httptest.Server
	roomID string
	a, b   *wsClient
	wa, wb protocol.Welcome
}

func newPair(t *testing.T) pair {
	t.Helper()
	srv := newTestServer(t)
	p := pair{srv: srv, roomID: createRoom(t, srv)}
	p.a = dial(t, srv, p.roomID)
	p.wa = p.a.join("Alex", "")
	p.b = dial(t, srv, p.roomID)
	p.wb = p.b.join("Sam", "")
	expect[protocol.ParticipantJoined](p.a)
	expect[protocol.CamUpdate](p.a)
	return p
}

func TestTwoClientsSeeTheSameBroadcasts(t *testing.T) {
	p := newPair(t)
	if p.wa.Polite || !p.wb.Polite {
		t.Errorf("roles: a polite=%v, b polite=%v", p.wa.Polite, p.wb.Polite)
	}
	if len(p.wb.Snapshot.Participants) != 2 || len(p.wb.IceServers) == 0 {
		t.Errorf("b's welcome = %+v", p.wb)
	}

	p.a.send(protocol.PlaybackLoad{VideoID: "dQw4w9WgXcQ"})
	p.a.send(protocol.PlaybackPlay{Position: 3})
	var last []byte
	for range 2 {
		ra, errA := p.a.readRaw()
		rb, errB := p.b.readRaw()
		if errA != nil || errB != nil {
			t.Fatalf("read: %v / %v", errA, errB)
		}
		if !bytes.Equal(ra, rb) {
			t.Fatalf("broadcasts differ:\na: %s\nb: %s", ra, rb)
		}
		last = ra
	}
	m, _ := protocol.DecodeServer(last)
	if pb := m.(protocol.PlaybackUpdate).State; !pb.Playing || pb.Position != 3 || *pb.VideoID != "dQw4w9WgXcQ" {
		t.Errorf("playback = %+v", pb)
	}

	p.a.send(protocol.Cursor{X: 0.25, Y: 0.75})
	if c := expect[protocol.CursorRelay](p.b); c.From != p.wa.You || c.X != 0.25 {
		t.Errorf("cursor = %+v", c)
	}
	p.a.send(protocol.Ping{T0: 1})
	expect[protocol.Pong](p.a) // proves a didn't get its own cursor back first
}

func TestResumeAfterDropRestoresPlayback(t *testing.T) {
	p := newPair(t)
	p.a.send(protocol.PlaybackLoad{VideoID: "dQw4w9WgXcQ"})
	p.a.send(protocol.PlaybackPlay{Position: 0})
	for _, c := range []*wsClient{p.a, p.b} {
		expect[protocol.PlaybackUpdate](c)
		expect[protocol.PlaybackUpdate](c)
	}

	p.b.ws.CloseNow()
	if r := expect[protocol.ParticipantReconnecting](p.a); r.ID != p.wb.You {
		t.Errorf("reconnecting = %+v", r)
	}
	if pb := expect[protocol.PlaybackUpdate](p.a).State; pb.Playing || *pb.WaitingFor != p.wb.You {
		t.Errorf("auto-pause = %+v", pb)
	}

	b2 := dial(t, p.srv, p.roomID)
	w := b2.join("Sam", p.wb.ResumeToken)
	if w.You != p.wb.You || !w.Polite || *w.Snapshot.Playback.WaitingFor != p.wb.You {
		t.Fatalf("resume welcome = %+v", w)
	}
	expect[protocol.ParticipantJoined](p.a)
	b2.send(protocol.PlaybackReady{})
	for _, c := range []*wsClient{p.a, b2} {
		if pb := expect[protocol.PlaybackUpdate](c).State; !pb.Playing || pb.WaitingFor != nil {
			t.Errorf("after ready = %+v", pb)
		}
	}
}

func TestReconnectReplacesStaleConnection(t *testing.T) {
	srv := newTestServer(t)
	id := createRoom(t, srv)
	a := dial(t, srv, id)
	wa := a.join("Alex", "")
	a2 := dial(t, srv, id)
	if w := a2.join("Alex", wa.ResumeToken); w.You != wa.You {
		t.Errorf("resume got a new identity: %+v", w)
	}
	expectClose(a, protocol.CloseReplaced)
}

func TestThirdPersonIsTurnedAway(t *testing.T) {
	p := newPair(t)
	c := dial(t, p.srv, p.roomID)
	c.send(protocol.Hello{Name: "Kim", Color: "#112233", PageSession: "ps-kim"})
	if e := expect[protocol.ErrorMsg](c); e.Code != protocol.CodeRoomFull {
		t.Errorf("error = %+v", e)
	}
	expectClose(c, protocol.CloseRoomFull)
}

func TestUnknownRoom(t *testing.T) {
	srv := newTestServer(t)
	c := dial(t, srv, "no-such-room")
	if e := expect[protocol.ErrorMsg](c); e.Code != protocol.CodeNotFound {
		t.Errorf("error = %+v", e)
	}
	expectClose(c, protocol.CloseNotFound)
}

func TestFirstMessageMustBeHello(t *testing.T) {
	srv := newTestServer(t)
	c := dial(t, srv, createRoom(t, srv))
	c.send(protocol.Ping{T0: 1})
	if e := expect[protocol.ErrorMsg](c); e.Code != protocol.CodeBadMessage {
		t.Errorf("error = %+v", e)
	}
	expectClose(c, protocol.CloseBadMessage)
}

func TestBadMessageKeepsConnectionOpen(t *testing.T) {
	p := newPair(t)
	p.a.writeRaw([]byte(`{"type":"dance"}`))
	if e := expect[protocol.ErrorMsg](p.a); e.Code != protocol.CodeBadMessage {
		t.Errorf("error = %+v", e)
	}
	p.a.send(protocol.Ping{T0: 1})
	expect[protocol.Pong](p.a)
}

func TestOversizedMessageClosesConnection(t *testing.T) {
	p := newPair(t)
	p.a.writeRaw(bytes.Repeat([]byte("x"), maxMessageBytes+1))
	expectClose(p.a, int(websocket.StatusMessageTooBig))
}

func TestFloodingIsRateLimited(t *testing.T) {
	srv := newTestServer(t)
	a := dial(t, srv, createRoom(t, srv))
	a.join("Alex", "")
	for range rateBurst + 100 {
		a.send(protocol.Cursor{X: 0.5, Y: 0.5})
	}
	if e := expect[protocol.ErrorMsg](a); e.Code != protocol.CodeRateLimited {
		t.Errorf("error = %+v", e)
	}
}

func TestLeaveFreesSeatImmediately(t *testing.T) {
	p := newPair(t)
	p.b.send(protocol.Leave{})
	expectClose(p.b, protocol.CloseNormal)
	if l := expect[protocol.ParticipantLeft](p.a); l.ID != p.wb.You {
		t.Errorf("left = %+v", l)
	}
	c := dial(t, p.srv, p.roomID)
	c.join("Kim", "")
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go -C server test -race ./internal/httpapi/`
Expected: FAIL to compile with `undefined: maxMessageBytes`, `undefined: rateBurst`.

- [ ] **Step 4: Write the WebSocket handler**

`server/internal/httpapi/ws.go`:

```go
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"popcorn/internal/protocol"
	"popcorn/internal/room"
	"popcorn/internal/turn"
)

const (
	maxMessageBytes = 16 << 10
	helloTimeout    = 10 * time.Second
	writeTimeout    = 5 * time.Second
	pingEvery       = 15 * time.Second
	pingTimeout     = 10 * time.Second
	iceTimeout      = 3 * time.Second
	sendQueueLen    = 256
	ratePerSecond   = 100
	rateBurst       = 200
)

var nextConnID atomic.Uint64

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return // Accept has already written an HTTP error
	}
	ws.SetReadLimit(maxMessageBytes)
	// r.Context() isn't safe to use after the connection is hijacked.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub, ok := s.reg.Get(roomID)
	if !ok {
		reject(ctx, ws, protocol.CodeNotFound, "Room not found.", protocol.CloseNotFound)
		return
	}
	hello, err := readHello(ctx, ws)
	if err != nil {
		reject(ctx, ws, protocol.CodeBadMessage, err.Error(), protocol.CloseBadMessage)
		return
	}
	conn := &wsConn{id: nextConnID.Add(1), ws: ws, send: make(chan []byte, sendQueueLen), cancel: cancel}
	go conn.writeLoop(ctx)
	go conn.pingLoop(ctx)
	joined := hub.Join(conn, room.HelloEvent{
		Hello:      hello,
		NewID:      room.NewParticipantID(),
		NewToken:   room.NewResumeToken(),
		IceServers: s.iceServers(ctx),
	})
	if !joined {
		reject(ctx, ws, protocol.CodeNotFound, "Room not found.", protocol.CloseNotFound)
		return
	}
	defer hub.Disconnect(conn.id)
	s.readLoop(ctx, ws, hub, conn.id)
}

func readHello(ctx context.Context, ws *websocket.Conn) (protocol.Hello, error) {
	ctx, cancel := context.WithTimeout(ctx, helloTimeout)
	defer cancel()
	typ, data, err := ws.Read(ctx)
	if err != nil {
		return protocol.Hello{}, err
	}
	m, err := decodeFrame(typ, data)
	if err != nil {
		return protocol.Hello{}, err
	}
	hello, ok := m.(protocol.Hello)
	if !ok {
		return protocol.Hello{}, errors.New("the first message must be hello")
	}
	return hello, nil
}

func (s *Server) readLoop(ctx context.Context, ws *websocket.Conn, hub *room.Hub, connID uint64) {
	limiter := rate.NewLimiter(ratePerSecond, rateBurst)
	var lastWarned time.Time
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if !limiter.Allow() {
			if time.Since(lastWarned) >= time.Second {
				lastWarned = time.Now()
				hub.Deliver(connID, protocol.ErrorMsg{Code: protocol.CodeRateLimited, Message: "Too many messages; some were dropped."})
			}
			continue
		}
		m, err := decodeFrame(typ, data)
		if err != nil {
			hub.Deliver(connID, protocol.ErrorMsg{Code: protocol.CodeBadMessage, Message: err.Error()})
			continue
		}
		if !hub.Message(connID, m) {
			return
		}
	}
}

func decodeFrame(typ websocket.MessageType, data []byte) (protocol.ClientMsg, error) {
	if typ != websocket.MessageText {
		return nil, fmt.Errorf("%w: binary frames are not supported", protocol.ErrBadMessage)
	}
	return protocol.DecodeClient(data)
}

func (s *Server) iceServers(ctx context.Context) []protocol.IceServer {
	ctx, cancel := context.WithTimeout(ctx, iceTimeout)
	defer cancel()
	servers, err := s.ice.ICEServers(ctx)
	if err != nil {
		s.log.Warn("TURN credentials unavailable; sending STUN only", "err", err)
		return turn.DefaultSTUN
	}
	return servers
}

// reject sends an error and closes. The close code tells the browser why,
// since it can't see the HTTP status of an upgrade.
func reject(ctx context.Context, ws *websocket.Conn, code, text string, closeCode int) {
	if b, err := protocol.Encode(protocol.ErrorMsg{Code: code, Message: text}); err == nil {
		wctx, cancel := context.WithTimeout(ctx, writeTimeout)
		ws.Write(wctx, websocket.MessageText, b)
		cancel()
	}
	ws.Close(websocket.StatusCode(closeCode), code)
}

// wsConn implements room.Conn. Only writeLoop writes messages, and only the
// hub calls Enqueue and Close.
type wsConn struct {
	id     uint64
	ws     *websocket.Conn
	send   chan []byte
	cancel context.CancelFunc

	closeOnce sync.Once
	closeCode int // written before send is closed, read after
}

func (c *wsConn) ID() uint64 { return c.id }

func (c *wsConn) Enqueue(msg []byte) bool {
	select {
	case c.send <- msg:
		return true
	default:
		return false
	}
}

func (c *wsConn) Close(code int) {
	c.closeOnce.Do(func() {
		c.closeCode = code
		close(c.send)
	})
}

func (c *wsConn) Kill() { c.cancel() }

func (c *wsConn) writeLoop(ctx context.Context) {
	defer c.cancel()
	for {
		select {
		case <-ctx.Done():
			c.ws.CloseNow()
			return
		case msg, ok := <-c.send:
			if !ok {
				c.ws.Close(websocket.StatusCode(c.closeCode), "")
				return
			}
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				c.ws.CloseNow()
				return
			}
		}
	}
}

// pingLoop notices dead connections (for example a laptop that lost Wi-Fi)
// so the grace period starts promptly.
func (c *wsConn) pingLoop(ctx context.Context) {
	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pctx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}
```

- [ ] **Step 5: Register the route**

In `server/internal/httpapi/server.go`, in `New`, add the `/ws` route after the rooms route:

```go
	mux.HandleFunc("POST /api/rooms", s.createRoom)
	mux.HandleFunc("GET /ws", s.serveWS)
```

- [ ] **Step 6: Tidy the module and run all tests repeatedly**

Run: `go -C server mod tidy && go -C server vet ./... && go -C server test -race -count=5 ./...`
Expected: `ok` for `httpapi`, `protocol`, `room` and `turn`, five runs each with no failures. `go.mod` lists `github.com/coder/websocket v1.8.15` and `golang.org/x/time v0.15.0` as direct requirements.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat(server): WebSocket endpoint with hello handshake, limits and heartbeat"
```

---

### Task 11: Server entry point and smoke test

**Files:**
- Create: `server/cmd/server/main.go`

**Interfaces:**
- Consumes: `httpapi.New`/`Config`, `room.NewRegistry`/`HubConfig`, `turn.New`, `webdist.FS`.
- Produces: the `server` binary. It reads `PORT` (default 8080) and the `TURN_*` environment variables, and shuts down gracefully on SIGINT or SIGTERM.

- [ ] **Step 1: Write the entry point**

`server/cmd/server/main.go`:

```go
// Command server runs Popcorn for Two: the room API, the WebSocket hub, and
// the embedded frontend.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"popcorn/internal/httpapi"
	"popcorn/internal/room"
	"popcorn/internal/turn"
	"popcorn/internal/webdist"
)

const maxRooms = 1000

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	ice, ok := turn.New(os.Getenv("TURN_PROVIDER"), os.Getenv("TURN_KEY_ID"), os.Getenv("TURN_API_TOKEN"))
	if !ok {
		logger.Warn("TURN is not configured; calls will use public STUN only and may fail on strict networks")
	}
	srv := &http.Server{
		Addr: ":" + port,
		Handler: httpapi.New(httpapi.Config{
			Registry: room.NewRegistry(room.HubConfig{Logger: logger}, maxRooms),
			ICE:      ice,
			Static:   webdist.FS(),
			Logger:   logger,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", srv.Addr)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
```

- [ ] **Step 2: Build it and smoke-test it**

```bash
go -C server vet ./...
go -C server build -o bin/popcorn ./cmd/server
PORT=8099 server/bin/popcorn &
SERVER_PID=$!
sleep 1
curl -s -X POST -w ' %{http_code}\n' localhost:8099/api/rooms
curl -s -w ' %{http_code}\n' localhost:8099/r/anything
kill -TERM $SERVER_PID
```

Expected:
- `{"roomId":"<22 characters>"} 201`
- `The frontend hasn't been built yet. 503` (correct for now; plan 2 builds the frontend)
- The server log shows a `TURN is not configured` warning, then `listening addr=:8099`.
- The process exits cleanly on SIGTERM.

- [ ] **Step 3: Ignore the build output**

Append to `.gitignore`:

```gitignore
/server/bin/
```

- [ ] **Step 4: Run the whole suite one last time**

Run: `go -C server test -race ./... && gofmt -l server`
Expected: every package `ok`, and `gofmt -l` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add .gitignore server/cmd
git commit -m "feat(server): server entry point with env config and graceful shutdown"
```
