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
