package room

import (
	"slices"
	"time"

	"popcorn/internal/protocol"
)

// Event is something that happened to a room.
type Event interface{ isEvent() }

// HelloEvent is a connection's first message. The caller supplies fresh IDs
// and the ICE servers so that Apply stays deterministic.
type HelloEvent struct {
	ConnID     uint64
	Hello      protocol.Hello
	NewID      string
	NewToken   string
	IceServers []protocol.IceServer
}

// MessageEvent is any message after hello.
type MessageEvent struct {
	ConnID uint64
	Msg    protocol.ClientMsg
}

// DisconnectEvent means a connection has gone away.
type DisconnectEvent struct{ ConnID uint64 }

// TickEvent arrives about once a second so Apply can expire grace periods
// and the room itself.
type TickEvent struct{}

func (HelloEvent) isEvent()      {}
func (MessageEvent) isEvent()    {}
func (DisconnectEvent) isEvent() {}
func (TickEvent) isEvent()       {}

// Outbound is a message for one connection. If Close is non-zero, the
// connection is closed with that WebSocket status code after Msg (if any) is
// sent.
type Outbound struct {
	ConnID uint64
	Msg    protocol.Message
	Close  int
}

// Apply is the room's only state transition. It is deterministic: randomness
// and time arrive through ev and now. Apply may modify the maps and slices
// inside s, so callers must use the returned state and discard s.
func Apply(s RoomState, ev Event, now time.Time) (RoomState, []Outbound) {
	r := reducer{s: s, now: now}
	switch ev := ev.(type) {
	case HelloEvent:
		r.hello(ev)
	case MessageEvent:
		r.message(ev)
	case DisconnectEvent:
		r.disconnect(ev.ConnID)
	case TickEvent:
		r.tick()
	}
	return r.s, r.out
}

type reducer struct {
	s   RoomState
	now time.Time
	out []Outbound
}

func (r *reducer) send(connID uint64, m protocol.Message) {
	r.out = append(r.out, Outbound{ConnID: connID, Msg: m})
}

func (r *reducer) closeConn(connID uint64, m protocol.Message, code int) {
	r.out = append(r.out, Outbound{ConnID: connID, Msg: m, Close: code})
}

func (r *reducer) broadcast(m protocol.Message) {
	for _, p := range r.s.Participants {
		if p.Connected() {
			r.send(p.ConnID, m)
		}
	}
}

func (r *reducer) toOthers(id string, m protocol.Message) {
	for _, p := range r.s.Participants {
		if p.ID != id && p.Connected() {
			r.send(p.ConnID, m)
		}
	}
}

func badMessage(text string) protocol.ErrorMsg {
	return protocol.ErrorMsg{Code: protocol.CodeBadMessage, Message: text}
}

func (r *reducer) hello(ev HelloEvent) {
	if r.s.byConn(ev.ConnID) >= 0 {
		r.send(ev.ConnID, badMessage("already joined"))
		return
	}
	if i := r.s.byToken(ev.Hello.ResumeToken); i >= 0 {
		r.resume(i, ev)
		return
	}
	if len(r.s.Participants) >= MaxParticipants {
		r.closeConn(ev.ConnID, protocol.ErrorMsg{Code: protocol.CodeRoomFull, Message: "This room already has two people."}, protocol.CloseRoomFull)
		return
	}
	// The newcomer takes whichever role the person already here doesn't hold.
	polite := len(r.s.Participants) == 1 && !r.s.Participants[0].Polite
	p := Participant{
		Participant: protocol.Participant{
			ID: ev.NewID, Name: ev.Hello.Name, Color: ev.Hello.Color, PageSession: ev.Hello.PageSession,
		},
		ResumeToken: ev.NewToken,
		Polite:      polite,
		ConnID:      ev.ConnID,
	}
	r.s.Participants = append(r.s.Participants, p)
	cam := protocol.CamState{Rect: defaultCamRect(polite)}
	r.s.Cams[p.ID] = cam
	r.s.EmptySince = time.Time{}
	r.welcome(p, ev.IceServers)
	r.toOthers(p.ID, protocol.ParticipantJoined{Participant: p.Participant})
	r.toOthers(p.ID, protocol.CamUpdate{CamID: p.ID, Rect: cam.Rect})
}

func (r *reducer) resume(i int, ev HelloEvent) {
	p := &r.s.Participants[i]
	if p.Connected() {
		// The server still thinks the old connection is alive; the new one wins.
		r.closeConn(p.ConnID, nil, protocol.CloseReplaced)
	}
	p.ConnID, p.DisconnectedAt = ev.ConnID, time.Time{}
	p.Name, p.Color, p.PageSession = ev.Hello.Name, ev.Hello.Color, ev.Hello.PageSession
	r.welcome(*p, ev.IceServers)
	r.toOthers(p.ID, protocol.ParticipantJoined{Participant: p.Participant})
}

func (r *reducer) welcome(p Participant, ice []protocol.IceServer) {
	if ice == nil {
		ice = []protocol.IceServer{}
	}
	r.send(p.ConnID, protocol.Welcome{
		You: p.ID, ResumeToken: p.ResumeToken, Polite: p.Polite, IceServers: ice, Snapshot: r.s.Snapshot(),
	})
}

func (r *reducer) message(ev MessageEvent) {
	i := r.s.byConn(ev.ConnID)
	if i < 0 {
		return // not joined, or a connection that has been replaced
	}
	id := r.s.Participants[i].ID
	switch m := ev.Msg.(type) {
	case protocol.Hello:
		r.send(ev.ConnID, badMessage("already joined"))
	case protocol.Ping:
		r.send(ev.ConnID, protocol.Pong{T0: m.T0, ServerTime: r.now.UnixMilli()})
	case protocol.Leave:
		r.remove(i)
		r.closeConn(ev.ConnID, nil, protocol.CloseNormal)
	case protocol.PlaybackLoad, protocol.PlaybackPlay, protocol.PlaybackPause,
		protocol.PlaybackSeek, protocol.PlaybackStalled, protocol.PlaybackReady:
		r.playback(id, m)
	case protocol.CamGrab:
		r.camGrab(id, m.CamID)
	case protocol.CamMove:
		r.camMove(id, m.CamID, m.Rect, false)
	case protocol.CamRelease:
		r.camMove(id, m.CamID, m.Rect, true)
	case protocol.Cursor:
		r.toOthers(id, protocol.CursorRelay{From: id, X: m.X, Y: m.Y})
	case protocol.CursorHide:
		r.toOthers(id, protocol.CursorHideRelay{From: id})
	case protocol.InkPoints:
		r.inkPoints(r.s.Participants[i], m)
	case protocol.InkEnd:
		r.toOthers(id, protocol.InkEndRelay{From: id, StrokeID: m.StrokeID})
	case protocol.InkClear:
		r.inkClear(id)
	case protocol.Signal:
		// toOthers skips a disconnected partner, so signals only flow while
		// both people are connected.
		r.toOthers(id, protocol.SignalRelay{From: id, Data: m.Data})
	}
}

func (r *reducer) disconnect(connID uint64) {
	i := r.s.byConn(connID)
	if i < 0 {
		return
	}
	p := &r.s.Participants[i]
	p.ConnID, p.DisconnectedAt = 0, r.now
	id := p.ID
	r.toOthers(id, protocol.ParticipantReconnecting{ID: id})
	if r.s.Playback.Playing {
		r.autoPause(id)
	}
	r.releaseCamsHeldBy(id)
}

func (r *reducer) tick() {
	for i := len(r.s.Participants) - 1; i >= 0; i-- {
		p := r.s.Participants[i]
		if !p.Connected() && r.now.Sub(p.DisconnectedAt) >= GracePeriod {
			r.remove(i)
		}
	}
	if len(r.s.Participants) == 0 && r.now.Sub(r.s.EmptySince) >= EmptyRoomTTL {
		r.s.Expired = true
	}
}

// remove frees a participant's seat: they left on purpose or their grace
// period ran out.
func (r *reducer) remove(i int) {
	p := r.s.Participants[i]
	r.s.Participants = slices.Delete(r.s.Participants, i, i+1)
	delete(r.s.Cams, p.ID)
	r.broadcast(protocol.ParticipantLeft{ID: p.ID})
	r.stopWaitingFor(p.ID)
	r.releaseCamsHeldBy(p.ID)
	if len(r.s.Participants) == 0 {
		r.s.EmptySince = r.now
	}
}
