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
