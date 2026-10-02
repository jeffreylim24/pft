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
