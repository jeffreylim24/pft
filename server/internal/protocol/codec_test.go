package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const fixturesDir = "../../../protocol-fixtures"

func readFixture(t *testing.T, dir, typ string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixturesDir, dir, typ+".json"))
	if err != nil {
		t.Fatalf("missing fixture %s/%s.json: %v", dir, typ, err)
	}
	return data
}

func assertSameJSON(t *testing.T, want, got []byte) {
	t.Helper()
	var w, g any
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("encoded message is not JSON: %v", err)
	}
	if !reflect.DeepEqual(w, g) {
		t.Errorf("round trip changed the message\nfixture: %s\nencoded: %s", want, got)
	}
}

func TestClientFixturesRoundTrip(t *testing.T) {
	for _, typ := range ClientTypes() {
		t.Run(typ, func(t *testing.T) {
			raw := readFixture(t, "client", typ)
			m, err := DecodeClient(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if m.MsgType() != typ {
				t.Fatalf("decoded as %q", m.MsgType())
			}
			out, err := Encode(m)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			assertSameJSON(t, raw, out)
		})
	}
}

func TestServerFixturesRoundTrip(t *testing.T) {
	for _, typ := range ServerTypes() {
		t.Run(typ, func(t *testing.T) {
			raw := readFixture(t, "server", typ)
			m, err := DecodeServer(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := Encode(m)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			assertSameJSON(t, raw, out)
		})
	}
}

func TestEveryFixtureMatchesAType(t *testing.T) {
	for dir, types := range map[string][]string{"client": ClientTypes(), "server": ServerTypes()} {
		entries, err := os.ReadDir(filepath.Join(fixturesDir, dir))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			typ := strings.TrimSuffix(e.Name(), ".json")
			if !slices.Contains(types, typ) {
				t.Errorf("%s/%s has no matching message type", dir, e.Name())
			}
		}
	}
}

func TestEncodePutsTypeFirst(t *testing.T) {
	cases := map[string]Message{
		`{"type":"playback.stalled"}`:            PlaybackStalled{},
		`{"type":"participant.left","id":"abc"}`: ParticipantLeft{ID: "abc"},
	}
	for want, m := range cases {
		got, err := Encode(m)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Errorf("Encode(%T) = %s, want %s", m, got, want)
		}
	}
}
