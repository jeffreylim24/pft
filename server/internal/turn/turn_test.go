package turn

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const cloudflareReply = `{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]}`

func TestCloudflareFetchesAndCaches(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/v1/turn/keys/key123/credentials/generate-ice-servers" {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("Authorization = %q", got)
		}
		var body struct {
			TTL int `json:"ttl"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TTL != 43200 {
			t.Errorf("body ttl = %d, err %v", body.TTL, err)
		}
		w.WriteHeader(http.StatusCreated)
		io.WriteString(w, cloudflareReply)
	}))
	defer srv.Close()

	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	cf := &Cloudflare{KeyID: "key123", APIToken: "secret", BaseURL: srv.URL, Now: func() time.Time { return now }}

	servers, err := cf.ICEServers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 2 || servers[1].Username != "u" || servers[1].Credential != "c" {
		t.Fatalf("servers = %+v", servers)
	}
	cf.ICEServers(context.Background())
	if n := calls.Load(); n != 1 {
		t.Errorf("second call within TTL/2 fetched again (%d calls)", n)
	}
	now = now.Add(6*time.Hour + time.Second)
	cf.ICEServers(context.Background())
	if n := calls.Load(); n != 2 {
		t.Errorf("call after TTL/2 should refetch (%d calls)", n)
	}
}

func TestCloudflareErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer srv.Close()
	cf := &Cloudflare{KeyID: "k", APIToken: "bad", BaseURL: srv.URL}
	_, err := cf.ICEServers(context.Background())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("err = %v, want one mentioning 401", err)
	}
}

func TestNew(t *testing.T) {
	if p, ok := New("cloudflare", "k", "t"); !ok {
		t.Error("cloudflare with credentials should be configured")
	} else if _, isCF := p.(*Cloudflare); !isCF {
		t.Errorf("got %T", p)
	}
	for _, args := range [][3]string{{"", "", ""}, {"cloudflare", "", "t"}, {"metered", "k", "t"}} {
		p, ok := New(args[0], args[1], args[2])
		if ok {
			t.Errorf("New%v should not be configured", args)
		}
		servers, _ := p.ICEServers(context.Background())
		if len(servers) == 0 || !strings.HasPrefix(servers[0].URLs[0], "stun:") {
			t.Errorf("New%v fallback = %+v", args, servers)
		}
	}
}
