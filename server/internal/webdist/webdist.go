// Package webdist embeds the built frontend. The build copies web/dist into
// ./dist; until then dist holds only .gitkeep and the server explains that
// the frontend hasn't been built.
package webdist

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err) // "dist" is a constant, valid path
	}
	return sub
}
