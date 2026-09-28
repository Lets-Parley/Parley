// Package web embeds the built frontend. Run `npm run build` in this directory
// before `go build`; the Docker build does this automatically.
package web

import (
	"bytes"
	"embed"
	"html"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// shareURLMarker is the comment in index.html that SPAHandler replaces with
// the instance's own og:url and canonical link.
const shareURLMarker = "<!--parley:share-url-->"

// SPAHandler serves the built frontend. publicURL is the instance's absolute
// address; when it is empty the shell carries no og:url or canonical link at
// all, because a relative one is not an address a chat client can use. The
// shell is rendered once here, not per request.
func SPAHandler(publicURL string) http.HandlerFunc {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))

	raw, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		panic(err)
	}
	tags := ""
	if publicURL != "" {
		u := html.EscapeString(publicURL)
		tags = `<meta property="og:url" content="` + u + `" />` + "\n    " +
			`<link rel="canonical" href="` + u + `" />`
	}
	shell := bytes.Replace(raw, []byte(shareURLMarker), []byte(tags), 1)

	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(sub, path); err != nil || path == "index.html" {
			// Client-side route: serve the app shell.
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(shell)
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}
