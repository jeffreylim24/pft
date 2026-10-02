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
