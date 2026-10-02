// Package httpapi is the server's HTTP surface: room creation, the WebSocket
// endpoint, and the embedded frontend.
package httpapi

import (
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"

	"popcorn/internal/room"
	"popcorn/internal/turn"
)

type Config struct {
	Registry *room.Registry
	ICE      turn.Provider
	Static   fs.FS // the built frontend; must contain index.html to be useful
	Logger   *slog.Logger
}

type Server struct {
	reg *room.Registry
	ice turn.Provider
	log *slog.Logger
}

func New(cfg Config) http.Handler {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{reg: cfg.Registry, ice: cfg.ICE, log: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms", s.createRoom)
	mux.Handle("GET /api/", http.NotFoundHandler())
	mux.Handle("GET /", spa(cfg.Static))
	return mux
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	id, err := s.reg.Create()
	if err != nil {
		s.log.Warn("room not created", "err", err)
		http.Error(w, "Too many rooms right now. Try again later.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"roomId": id})
}
