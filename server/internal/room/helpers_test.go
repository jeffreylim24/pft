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
