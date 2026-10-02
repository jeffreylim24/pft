package protocol

import (
	"encoding/json"
	"maps"
	"slices"
)

// Message is anything that travels over the WebSocket. MsgType is the value
// of its "type" field.
type Message interface {
	MsgType() string
}

// ClientMsg is a message the browser sends.
type ClientMsg interface {
	Message
	isClientMsg()
}

// ---- Client → server ----

type Hello struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	PageSession string `json:"pageSession"`
	ResumeToken string `json:"resumeToken,omitempty"`
}

type Ping struct {
	T0 float64 `json:"t0"`
}

type PlaybackLoad struct {
	VideoID string `json:"videoId"`
}

type PlaybackPlay struct {
	Position float64 `json:"position"`
}

type PlaybackPause struct {
	Position float64 `json:"position"`
}

type PlaybackSeek struct {
	Position float64 `json:"position"`
}

type PlaybackStalled struct{}

type PlaybackReady struct{}

type CamGrab struct {
	CamID string `json:"camId"`
}

type CamMove struct {
	CamID string `json:"camId"`
	Rect  Rect   `json:"rect"`
}

type CamRelease struct {
	CamID string `json:"camId"`
	Rect  Rect   `json:"rect"`
}

type Cursor struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type CursorHide struct{}

type InkPoints struct {
	StrokeID string  `json:"strokeId"`
	Mode     string  `json:"mode"`
	Color    string  `json:"color"`
	Width    float64 `json:"width"`
	Points   []Point `json:"points"`
}

type InkEnd struct {
	StrokeID string `json:"strokeId"`
}

type InkClear struct{}

type Signal struct {
	Data json.RawMessage `json:"data"`
}

type Leave struct{}

func (Hello) MsgType() string           { return "hello" }
func (Ping) MsgType() string            { return "ping" }
func (PlaybackLoad) MsgType() string    { return "playback.load" }
func (PlaybackPlay) MsgType() string    { return "playback.play" }
func (PlaybackPause) MsgType() string   { return "playback.pause" }
func (PlaybackSeek) MsgType() string    { return "playback.seek" }
func (PlaybackStalled) MsgType() string { return "playback.stalled" }
func (PlaybackReady) MsgType() string   { return "playback.ready" }
func (CamGrab) MsgType() string         { return "cam.grab" }
func (CamMove) MsgType() string         { return "cam.move" }
func (CamRelease) MsgType() string      { return "cam.release" }
func (Cursor) MsgType() string          { return "cursor" }
func (CursorHide) MsgType() string      { return "cursor.hide" }
func (InkPoints) MsgType() string       { return "ink.points" }
func (InkEnd) MsgType() string          { return "ink.end" }
func (InkClear) MsgType() string        { return "ink.clear" }
func (Signal) MsgType() string          { return "signal" }
func (Leave) MsgType() string           { return "leave" }

func (Hello) isClientMsg()           {}
func (Ping) isClientMsg()            {}
func (PlaybackLoad) isClientMsg()    {}
func (PlaybackPlay) isClientMsg()    {}
func (PlaybackPause) isClientMsg()   {}
func (PlaybackSeek) isClientMsg()    {}
func (PlaybackStalled) isClientMsg() {}
func (PlaybackReady) isClientMsg()   {}
func (CamGrab) isClientMsg()         {}
func (CamMove) isClientMsg()         {}
func (CamRelease) isClientMsg()      {}
func (Cursor) isClientMsg()          {}
func (CursorHide) isClientMsg()      {}
func (InkPoints) isClientMsg()       {}
func (InkEnd) isClientMsg()          {}
func (InkClear) isClientMsg()        {}
func (Signal) isClientMsg()          {}
func (Leave) isClientMsg()           {}

// ---- Server → client ----

type Welcome struct {
	You         string      `json:"you"`
	ResumeToken string      `json:"resumeToken"`
	Polite      bool        `json:"polite"`
	IceServers  []IceServer `json:"iceServers"`
	Snapshot    Snapshot    `json:"snapshot"`
}

type Pong struct {
	T0         float64 `json:"t0"`
	ServerTime int64   `json:"serverTime"`
}

type ParticipantJoined struct {
	Participant Participant `json:"participant"`
}

type ParticipantReconnecting struct {
	ID string `json:"id"`
}

type ParticipantLeft struct {
	ID string `json:"id"`
}

type PlaybackUpdate struct {
	State PlaybackState `json:"state"`
}

type CamUpdate struct {
	CamID  string  `json:"camId"`
	Rect   Rect    `json:"rect"`
	Holder *string `json:"holder"`
}

type CursorRelay struct {
	From string  `json:"from"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

type CursorHideRelay struct {
	From string `json:"from"`
}

type InkPointsRelay struct {
	From     string  `json:"from"`
	StrokeID string  `json:"strokeId"`
	Mode     string  `json:"mode"`
	Color    string  `json:"color"`
	Width    float64 `json:"width"`
	Points   []Point `json:"points"`
}

type InkEndRelay struct {
	From     string `json:"from"`
	StrokeID string `json:"strokeId"`
}

type InkClearRelay struct {
	From string `json:"from"`
}

type SignalRelay struct {
	From string          `json:"from"`
	Data json.RawMessage `json:"data"`
}

type ErrorMsg struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (Welcome) MsgType() string                 { return "welcome" }
func (Pong) MsgType() string                    { return "pong" }
func (ParticipantJoined) MsgType() string       { return "participant.joined" }
func (ParticipantReconnecting) MsgType() string { return "participant.reconnecting" }
func (ParticipantLeft) MsgType() string         { return "participant.left" }
func (PlaybackUpdate) MsgType() string          { return "playback" }
func (CamUpdate) MsgType() string               { return "cam" }
func (CursorRelay) MsgType() string             { return "cursor" }
func (CursorHideRelay) MsgType() string         { return "cursor.hide" }
func (InkPointsRelay) MsgType() string          { return "ink.points" }
func (InkEndRelay) MsgType() string             { return "ink.end" }
func (InkClearRelay) MsgType() string           { return "ink.clear" }
func (SignalRelay) MsgType() string             { return "signal" }
func (ErrorMsg) MsgType() string                { return "error" }

// ---- Registries ----

type decoder func([]byte) (Message, error)

func decodeAs[T Message](data []byte) (Message, error) {
	var m T
	err := json.Unmarshal(data, &m)
	return m, err
}

var clientDecoders = map[string]decoder{
	Hello{}.MsgType():           decodeAs[Hello],
	Ping{}.MsgType():            decodeAs[Ping],
	PlaybackLoad{}.MsgType():    decodeAs[PlaybackLoad],
	PlaybackPlay{}.MsgType():    decodeAs[PlaybackPlay],
	PlaybackPause{}.MsgType():   decodeAs[PlaybackPause],
	PlaybackSeek{}.MsgType():    decodeAs[PlaybackSeek],
	PlaybackStalled{}.MsgType(): decodeAs[PlaybackStalled],
	PlaybackReady{}.MsgType():   decodeAs[PlaybackReady],
	CamGrab{}.MsgType():         decodeAs[CamGrab],
	CamMove{}.MsgType():         decodeAs[CamMove],
	CamRelease{}.MsgType():      decodeAs[CamRelease],
	Cursor{}.MsgType():          decodeAs[Cursor],
	CursorHide{}.MsgType():      decodeAs[CursorHide],
	InkPoints{}.MsgType():       decodeAs[InkPoints],
	InkEnd{}.MsgType():          decodeAs[InkEnd],
	InkClear{}.MsgType():        decodeAs[InkClear],
	Signal{}.MsgType():          decodeAs[Signal],
	Leave{}.MsgType():           decodeAs[Leave],
}

var serverDecoders = map[string]decoder{
	Welcome{}.MsgType():                 decodeAs[Welcome],
	Pong{}.MsgType():                    decodeAs[Pong],
	ParticipantJoined{}.MsgType():       decodeAs[ParticipantJoined],
	ParticipantReconnecting{}.MsgType(): decodeAs[ParticipantReconnecting],
	ParticipantLeft{}.MsgType():         decodeAs[ParticipantLeft],
	PlaybackUpdate{}.MsgType():          decodeAs[PlaybackUpdate],
	CamUpdate{}.MsgType():               decodeAs[CamUpdate],
	CursorRelay{}.MsgType():             decodeAs[CursorRelay],
	CursorHideRelay{}.MsgType():         decodeAs[CursorHideRelay],
	InkPointsRelay{}.MsgType():          decodeAs[InkPointsRelay],
	InkEndRelay{}.MsgType():             decodeAs[InkEndRelay],
	InkClearRelay{}.MsgType():           decodeAs[InkClearRelay],
	SignalRelay{}.MsgType():             decodeAs[SignalRelay],
	ErrorMsg{}.MsgType():                decodeAs[ErrorMsg],
}

// ClientTypes lists every client → server message type, sorted.
func ClientTypes() []string { return slices.Sorted(maps.Keys(clientDecoders)) }

// ServerTypes lists every server → client message type, sorted.
func ServerTypes() []string { return slices.Sorted(maps.Keys(serverDecoders)) }
