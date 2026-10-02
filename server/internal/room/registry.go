package room

import (
	"errors"
	"sync"
)

var ErrTooManyRooms = errors.New("too many rooms")

// Registry maps room IDs to hubs. A hub removes itself when its room expires.
type Registry struct {
	cfg      HubConfig
	maxRooms int

	mu   sync.Mutex
	hubs map[string]*Hub
}

func NewRegistry(cfg HubConfig, maxRooms int) *Registry {
	return &Registry{cfg: cfg, maxRooms: maxRooms, hubs: map[string]*Hub{}}
}

// Create starts a new room and returns its ID.
func (r *Registry) Create() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.hubs) >= r.maxRooms {
		return "", ErrTooManyRooms
	}
	id := NewRoomID()
	h := newHub(id, r.cfg, func() { r.remove(id) })
	r.hubs[id] = h
	go h.run()
	return id, nil
}

func (r *Registry) Get(id string) (*Hub, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, ok := r.hubs[id]
	return h, ok
}

func (r *Registry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.hubs)
}

func (r *Registry) remove(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.hubs, id)
}
