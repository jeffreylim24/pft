package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"popcorn/internal/room"
	"popcorn/internal/turn"
)

var testStatic = fstest.MapFS{
	"index.html":        {Data: []byte("<!doctype html><title>Popcorn</title>")},
	"assets/app-abc.js": {Data: []byte("console.log(1)")},
}

func newHandler(reg *room.Registry, static fstest.MapFS) http.Handler {
	return New(Config{Registry: reg, ICE: turn.Static(turn.DefaultSTUN), Static: static})
}

func TestCreateRoom(t *testing.T) {
	reg := room.NewRegistry(room.HubConfig{}, 10)
	rec := httptest.NewRecorder()
	newHandler(reg, testStatic).ServeHTTP(rec, httptest.NewRequest("POST", "/api/rooms", nil))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var body struct {
		RoomID string `json:"roomId"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.RoomID) != 22 {
		t.Errorf("roomId %q should be 22 characters", body.RoomID)
	}
	if _, ok := reg.Get(body.RoomID); !ok {
		t.Error("room is not in the registry")
	}
}

func TestCreateRoomWhenFull(t *testing.T) {
	reg := room.NewRegistry(room.HubConfig{}, 1)
	reg.Create()
	rec := httptest.NewRecorder()
	newHandler(reg, testStatic).ServeHTTP(rec, httptest.NewRequest("POST", "/api/rooms", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", rec.Code)
	}
}

func TestStaticAndSPAFallback(t *testing.T) {
	h := newHandler(room.NewRegistry(room.HubConfig{}, 10), testStatic)
	cases := []struct {
		path, wantBody, wantCache string
		wantCode                  int
	}{
		{"/", "<!doctype html>", "no-cache", 200},
		{"/r/abc123", "<!doctype html>", "no-cache", 200},
		{"/assets/app-abc.js", "console.log", "immutable", 200},
		{"/assets/missing.js", "", "", 404},
		{"/api/rooms", "", "", 404},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", c.path, nil))
			if rec.Code != c.wantCode {
				t.Fatalf("status %d, want %d", rec.Code, c.wantCode)
			}
			body, _ := io.ReadAll(rec.Body)
			if !strings.Contains(string(body), c.wantBody) {
				t.Errorf("body %q missing %q", body, c.wantBody)
			}
			if !strings.Contains(rec.Header().Get("Cache-Control"), c.wantCache) {
				t.Errorf("Cache-Control %q missing %q", rec.Header().Get("Cache-Control"), c.wantCache)
			}
		})
	}
}

func TestUnbuiltFrontendExplainsItself(t *testing.T) {
	h := newHandler(room.NewRegistry(room.HubConfig{}, 10), fstest.MapFS{})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "hasn't been built") {
		t.Errorf("status %d body %q", rec.Code, rec.Body)
	}
}
