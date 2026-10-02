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
