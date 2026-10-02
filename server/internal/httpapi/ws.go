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
