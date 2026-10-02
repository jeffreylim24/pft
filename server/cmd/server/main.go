// Command server runs Popcorn for Two: the room API, the WebSocket hub, and
// the embedded frontend.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"popcorn/internal/httpapi"
	"popcorn/internal/room"
	"popcorn/internal/turn"
	"popcorn/internal/webdist"
)

const maxRooms = 1000

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	ice, ok := turn.New(os.Getenv("TURN_PROVIDER"), os.Getenv("TURN_KEY_ID"), os.Getenv("TURN_API_TOKEN"))
	if !ok {
		logger.Warn("TURN is not configured; calls will use public STUN only and may fail on strict networks")
	}
	srv := &http.Server{
		Addr: ":" + port,
		Handler: httpapi.New(httpapi.Config{
			Registry: room.NewRegistry(room.HubConfig{Logger: logger}, maxRooms),
			ICE:      ice,
			Static:   webdist.FS(),
			Logger:   logger,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", srv.Addr)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
