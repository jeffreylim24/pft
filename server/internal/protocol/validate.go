package protocol

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MaxNameRunes = 32
	MaxIDLen     = 64 // participant IDs, cam IDs, stroke IDs, tokens, page sessions
	MaxInkBatch  = 64 // points per ink.points message
)

var (
	videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	colorPattern   = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// requiredFields lists fields that must be present and non-null. Fields not
// listed may be omitted and take their zero value.
var requiredFields = map[string][]string{
	Hello{}.MsgType():         {"name", "color", "pageSession"},
	Ping{}.MsgType():          {"t0"},
	PlaybackLoad{}.MsgType():  {"videoId"},
	PlaybackPlay{}.MsgType():  {"position"},
	PlaybackPause{}.MsgType(): {"position"},
	PlaybackSeek{}.MsgType():  {"position"},
	CamGrab{}.MsgType():       {"camId"},
	CamMove{}.MsgType():       {"camId", "rect"},
	CamRelease{}.MsgType():    {"camId", "rect"},
	Cursor{}.MsgType():        {"x", "y"},
	InkPoints{}.MsgType():     {"strokeId", "mode", "points"},
	InkEnd{}.MsgType():        {"strokeId"},
	Signal{}.MsgType():        {"data"},
}

func checkRequired(typ string, data []byte) error {
	fields := requiredFields[typ]
	if len(fields) == 0 {
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return badf("not a JSON object")
	}
	for _, f := range fields {
		if v, ok := obj[f]; !ok || string(v) == "null" {
			return badf("%s: missing %s", typ, f)
		}
	}
	return nil
}

// normalize rejects messages the server can't use and clamps the rest:
// coordinates to [0,1] and playback positions to >= 0.
func normalize(m ClientMsg) (ClientMsg, error) {
	switch v := m.(type) {
	case Hello:
		v.Name = strings.TrimSpace(v.Name)
		if n := utf8.RuneCountInString(v.Name); n == 0 || n > MaxNameRunes {
			return nil, badf("hello: name must be 1-%d characters", MaxNameRunes)
		}
		if !colorPattern.MatchString(v.Color) {
			return nil, badf("hello: color must look like #rrggbb")
		}
		if !validID(v.PageSession) {
			return nil, badf("hello: bad pageSession")
		}
		if len(v.ResumeToken) > MaxIDLen {
			return nil, badf("hello: bad resumeToken")
		}
		return v, nil
	case PlaybackLoad:
		if !videoIDPattern.MatchString(v.VideoID) {
			return nil, badf("playback.load: videoId must be 11 characters of A-Z a-z 0-9 _ -")
		}
		return v, nil
	case PlaybackPlay:
		v.Position = max(v.Position, 0)
		return v, nil
	case PlaybackPause:
		v.Position = max(v.Position, 0)
		return v, nil
	case PlaybackSeek:
		v.Position = max(v.Position, 0)
		return v, nil
	case CamGrab:
		if !validID(v.CamID) {
			return nil, badf("cam.grab: bad camId")
		}
		return v, nil
	case CamMove:
		if !validID(v.CamID) {
			return nil, badf("cam.move: bad camId")
		}
		v.Rect = unitRect(v.Rect)
		return v, nil
	case CamRelease:
		if !validID(v.CamID) {
			return nil, badf("cam.release: bad camId")
		}
		v.Rect = unitRect(v.Rect)
		return v, nil
	case Cursor:
		v.X, v.Y = unit(v.X), unit(v.Y)
		return v, nil
	case InkPoints:
		if !validID(v.StrokeID) {
			return nil, badf("ink.points: bad strokeId")
		}
		if v.Mode != InkFading && v.Mode != InkSticky {
			return nil, badf("ink.points: mode must be %q or %q", InkFading, InkSticky)
		}
		if len(v.Points) == 0 || len(v.Points) > MaxInkBatch {
			return nil, badf("ink.points: a batch must have 1-%d points", MaxInkBatch)
		}
		for i, p := range v.Points {
			v.Points[i] = Point{inkCoord(p[0]), inkCoord(p[1])}
		}
		return v, nil
	case InkEnd:
		if !validID(v.StrokeID) {
			return nil, badf("ink.end: bad strokeId")
		}
		return v, nil
	}
	return m, nil
}

func validID(s string) bool { return s != "" && len(s) <= MaxIDLen }

func unit(v float64) float64 { return min(max(v, 0), 1) }

// inkCoord clamps and rounds to 4 decimals: still sub-pixel on a 4K stage,
// but it shrinks a full sticky board's JSON by more than half.
func inkCoord(v float64) float64 { return math.Round(unit(v)*1e4) / 1e4 }

func unitRect(r Rect) Rect { return Rect{X: unit(r.X), Y: unit(r.Y), W: unit(r.W), H: unit(r.H)} }
