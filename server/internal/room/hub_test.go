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
