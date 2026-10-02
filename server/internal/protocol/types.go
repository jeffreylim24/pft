// Package protocol defines the JSON messages that travel over the WebSocket
// between the browser and the server. web/src/protocol mirrors these types by
// hand; the files in protocol-fixtures/ keep the two sides in sync.
package protocol

// Rect is a cam tile's position and size, as fractions of the stage.
type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Point is an [x, y] pair, as fractions of the stage.
type Point [2]float64

type Participant struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	PageSession string `json:"pageSession"`
}

type SnapshotParticipant struct {
	Participant
	Connected bool `json:"connected"`
}

type PlaybackState struct {
	VideoID    *string `json:"videoId"`
	Playing    bool    `json:"playing"`
	Position   float64 `json:"position"`  // seconds, as of UpdatedAt
	UpdatedAt  int64   `json:"updatedAt"` // server Unix milliseconds
	WaitingFor *string `json:"waitingFor"`
	AutoResume bool    `json:"autoResume"`
}

type CamState struct {
	Rect   Rect    `json:"rect"`
	Holder *string `json:"holder"`
}

type Stroke struct {
	ID     string  `json:"id"`
	Author string  `json:"author"`
	Color  string  `json:"color"`
	Width  float64 `json:"width"`
	Points []Point `json:"points"`
}

type Snapshot struct {
	Participants  []SnapshotParticipant `json:"participants"`
	Playback      PlaybackState         `json:"playback"`
	Cams          map[string]CamState   `json:"cams"`
	StickyStrokes []Stroke              `json:"stickyStrokes"`
}

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Ink modes.
const (
	InkFading = "fading"
	InkSticky = "sticky"
)

// Codes sent in ErrorMsg.Code.
const (
	CodeBadMessage  = "bad_message"
	CodeRateLimited = "rate_limited"
	CodeRoomFull    = "room_full"
	CodeNotFound    = "not_found"
)

// WebSocket close codes. RFC 6455 reserves 4000-4999 for applications.
const (
	CloseNormal     = 1000 // the participant left on purpose
	CloseReplaced   = 4001 // the same participant connected again elsewhere
	CloseBadMessage = 4400 // the first message wasn't a valid hello
	CloseNotFound   = 4404
	CloseRoomFull   = 4409
)

// Ptr returns a pointer to v, for the nullable fields.
func Ptr[T any](v T) *T { return &v }
