// Package web embeds the built frontend. Run `npm run build` in this directory
// before `go build`; the Docker build does this automatically.
package web

import (
	"bytes"
	"embed"
	"html"
	"io/fs"
	"net/http"
	"strconv"
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
// page is split around its placeholder once here, so a request costs one
// concatenation.
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
	head, tail, _ := bytes.Cut(raw, []byte(shareURLMarker))
	base := strings.TrimRight(publicURL, "/")
	// shell renders the app page for one request. The URL tags name the page
	// actually requested — the path only, never the query or fragment — so a
	// shared room is not folded into the home page.
	bare := append(append(make([]byte, 0, len(head)+len(tail)), head...), tail...)
	shell := func(r *http.Request) []byte {
		if publicURL == "" {
			return bare
		}
		u := html.EscapeString(base + r.URL.EscapedPath())
		tags := `<meta property="og:url" content="` + u + `" />` + "\n    " +
			`<link rel="canonical" href="` + u + `" />`
		out := make([]byte, 0, len(head)+len(tags)+len(tail))
		return append(append(append(out, head...), tags...), tail...)
	}

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
			body := shell(r)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.Write(body)
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}
