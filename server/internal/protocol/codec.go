package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrBadMessage wraps every decoding and validation failure. The server
// answers these with an error message of code bad_message.
var ErrBadMessage = errors.New("bad message")

func badf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrBadMessage, fmt.Sprintf(format, args...))
}

// Encode marshals m and puts its "type" field first.
func Encode(m Message) ([]byte, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	typ, err := json.Marshal(m.MsgType())
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(body)+len(typ)+10)
	out = append(out, `{"type":`...)
	out = append(out, typ...)
	if len(body) > len("{}") {
		out = append(out, ',')
		out = append(out, body[1:]...)
	} else {
		out = append(out, '}')
	}
	return out, nil
}

// DecodeClient parses and validates a message from the browser. Numbers are
// clamped to their allowed ranges; anything else invalid is an ErrBadMessage.
func DecodeClient(data []byte) (ClientMsg, error) {
	m, err := decode(data, clientDecoders)
	if err != nil {
		return nil, err
	}
	if err := checkRequired(m.MsgType(), data); err != nil {
		return nil, err
	}
	return normalize(m.(ClientMsg))
}

// DecodeServer parses a message from the server. The server never needs it;
// tests use it to read what the server sent.
func DecodeServer(data []byte) (Message, error) {
	return decode(data, serverDecoders)
}

func decode(data []byte, decoders map[string]decoder) (Message, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, badf("not a JSON object with a string type")
	}
	dec, ok := decoders[head.Type]
	if !ok {
		return nil, badf("unknown type %q", head.Type)
	}
	m, err := dec(data)
	if err != nil {
		return nil, badf("%s: %v", head.Type, err)
	}
	return m, nil
}
