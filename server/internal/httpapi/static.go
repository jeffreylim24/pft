package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spa serves the built frontend. A path that isn't a file and has no
// extension gets index.html, so client-side routes like /r/<id> work.
func spa(static fs.FS) http.Handler {
	files := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if info, err := fs.Stat(static, name); err == nil && !info.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					// Vite puts a content hash in every asset's filename.
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
		}
		serveIndex(w, static)
	})
}

func serveIndex(w http.ResponseWriter, static fs.FS) {
	page, err := fs.ReadFile(static, "index.html")
	if err != nil {
		http.Error(w, "The frontend hasn't been built yet.", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(page)
}
