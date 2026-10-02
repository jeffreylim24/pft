// Package turn supplies the ICE servers sent to browsers in welcome. The
// provider's API key stays on the server; browsers only ever see short-lived
// credentials.
package turn

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"popcorn/internal/protocol"
)

type Provider interface {
	ICEServers(ctx context.Context) ([]protocol.IceServer, error)
}

// DefaultSTUN is used when TURN isn't configured or a credential fetch fails.
var DefaultSTUN = []protocol.IceServer{
	{URLs: []string{"stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"}},
}

// Static always returns the same servers.
type Static []protocol.IceServer

func (s Static) ICEServers(context.Context) ([]protocol.IceServer, error) { return s, nil }

// New returns the configured provider. If TURN isn't configured it returns
// STUN only and ok == false, so the caller can log a warning.
func New(provider, keyID, apiToken string) (p Provider, ok bool) {
	if provider == "cloudflare" && keyID != "" && apiToken != "" {
		return &Cloudflare{KeyID: keyID, APIToken: apiToken}, true
	}
	return Static(DefaultSTUN), false
}

const defaultCloudflareURL = "https://rtc.live.cloudflare.com"

// Cloudflare fetches credentials from Cloudflare Realtime TURN. One set of
// credentials is shared by every join until half its TTL has passed.
type Cloudflare struct {
	KeyID    string
	APIToken string
	BaseURL  string           // default https://rtc.live.cloudflare.com
	TTL      time.Duration    // default 12h
	HTTP     *http.Client     // default http.DefaultClient
	Now      func() time.Time // default time.Now

	mu      sync.Mutex
	cached  []protocol.IceServer
	expires time.Time
}

func (c *Cloudflare) ICEServers(ctx context.Context) ([]protocol.IceServer, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.cached != nil && now.Before(c.expires) {
		return c.cached, nil
	}
	servers, err := c.fetch(ctx)
	if err != nil {
		return nil, err
	}
	c.cached, c.expires = servers, now.Add(c.ttl()/2)
	return servers, nil
}

func (c *Cloudflare) fetch(ctx context.Context) ([]protocol.IceServer, error) {
	endpoint := c.baseURL() + "/v1/turn/keys/" + url.PathEscape(c.KeyID) + "/credentials/generate-ice-servers"
	body := fmt.Sprintf(`{"ttl":%d}`, int(c.ttl().Seconds()))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("turn: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("turn: cloudflare returned %s", resp.Status)
	}
	var out struct {
		IceServers []protocol.IceServer `json:"iceServers"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		return nil, fmt.Errorf("turn: decoding response: %w", err)
	}
	if len(out.IceServers) == 0 {
		return nil, fmt.Errorf("turn: cloudflare returned no ICE servers")
	}
	return out.IceServers, nil
}

func (c *Cloudflare) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return defaultCloudflareURL
}

func (c *Cloudflare) ttl() time.Duration {
	if c.TTL > 0 {
		return c.TTL
	}
	return 12 * time.Hour
}

func (c *Cloudflare) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Cloudflare) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}
