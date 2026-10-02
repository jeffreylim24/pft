package room

import (
	"encoding/json"
	"fmt"
	"math"
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
		m := ink(fmt.Sprintf("s%d", i), protocol.InkSticky, MaxStrokePoints)
		for j := range m.Points {
			// Realistic coordinates, at the 4-decimal precision protocol.DecodeClient leaves.
			x, y := 0.1234+float64(j%7000)/10000, 0.8765-float64(j%5000)/10000
			m.Points[j] = protocol.Point{math.Round(x*1e4) / 1e4, math.Round(y*1e4) / 1e4}
		}
		h.send(1, m)
	}
	if h.s.stickyPoints > MaxStickyPoints || h.s.Sticky[0].ID != "s1" {
		t.Fatalf("points = %d, first stroke %s", h.s.stickyPoints, h.s.Sticky[0].ID)
	}
	w := one[protocol.Welcome](t, h.hello(3, "tok-p1"), 3)
	b, _ := json.Marshal(w)
	if len(b) > 2<<20 {
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
