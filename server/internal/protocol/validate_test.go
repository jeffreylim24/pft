package protocol

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestDecodeClientRejects(t *testing.T) {
	tooManyPoints := strings.Repeat("[0.1,0.1],", MaxInkBatch) + "[0.1,0.1]"
	cases := map[string]string{
		"not JSON":            `nope`,
		"JSON array":          `[]`,
		"unknown type":        `{"type":"dance"}`,
		"missing type":        `{"position":1}`,
		"type is a number":    `{"type":5}`,
		"wrong field type":    `{"type":"playback.play","position":"ten"}`,
		"missing position":    `{"type":"playback.play"}`,
		"null position":       `{"type":"playback.play","position":null}`,
		"short video id":      `{"type":"playback.load","videoId":"short"}`,
		"video id with slash": `{"type":"playback.load","videoId":"abc/defghij"}`,
		"blank name":          `{"type":"hello","name":"   ","color":"#112233","pageSession":"p"}`,
		"long name":           fmt.Sprintf(`{"type":"hello","name":"%s","color":"#112233","pageSession":"p"}`, strings.Repeat("a", MaxNameRunes+1)),
		"bad color":           `{"type":"hello","name":"A","color":"red","pageSession":"p"}`,
		"missing pageSession": `{"type":"hello","name":"A","color":"#112233"}`,
		"long resume token":   fmt.Sprintf(`{"type":"hello","name":"A","color":"#112233","pageSession":"p","resumeToken":"%s"}`, strings.Repeat("t", MaxIDLen+1)),
		"empty cam id":        `{"type":"cam.grab","camId":""}`,
		"missing rect":        `{"type":"cam.move","camId":"c"}`,
		"bad ink mode":        `{"type":"ink.points","strokeId":"s","mode":"glitter","points":[[0,0]]}`,
		"empty ink batch":     `{"type":"ink.points","strokeId":"s","mode":"fading","points":[]}`,
		"oversized ink batch": `{"type":"ink.points","strokeId":"s","mode":"fading","points":[` + tooManyPoints + `]}`,
		"missing signal data": `{"type":"signal"}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			m, err := DecodeClient([]byte(raw))
			if !errors.Is(err, ErrBadMessage) {
				t.Fatalf("got (%+v, %v), want ErrBadMessage", m, err)
			}
		})
	}
}

func TestDecodeClientNormalizes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want ClientMsg
	}{
		{"negative position becomes zero", `{"type":"playback.seek","position":-5}`, PlaybackSeek{Position: 0}},
		{"cursor is clamped to the stage", `{"type":"cursor","x":-0.2,"y":1.7}`, Cursor{X: 0, Y: 1}},
		{
			"rect is clamped to the unit square",
			`{"type":"cam.move","camId":"c","rect":{"x":-1,"y":0.5,"w":3,"h":0.2}}`,
			CamMove{CamID: "c", Rect: Rect{X: 0, Y: 0.5, W: 1, H: 0.2}},
		},
		{
			"ink points are clamped",
			`{"type":"ink.points","strokeId":"s","mode":"fading","color":"#000000","width":0.004,"points":[[-1,2],[0.5,0.5]]}`,
			InkPoints{StrokeID: "s", Mode: InkFading, Color: "#000000", Width: 0.004, Points: []Point{{0, 1}, {0.5, 0.5}}},
		},
		{
			"name is trimmed",
			`{"type":"hello","name":"  Alex  ","color":"#112233","pageSession":"p"}`,
			Hello{Name: "Alex", Color: "#112233", PageSession: "p"},
		},
		{"messages without fields are fine", `{"type":"playback.stalled"}`, PlaybackStalled{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := DecodeClient([]byte(c.raw))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %+v, want %+v", got, c.want)
			}
		})
	}
}
