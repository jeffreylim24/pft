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
