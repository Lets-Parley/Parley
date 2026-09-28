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
// the instance's share tags: og:url, canonical link, share image and card.
const shareURLMarker = "<!--parley:share-url-->"

// SPAHandler serves the built frontend. publicURL is the instance's absolute
// address; when it is empty the shell carries no og:url, canonical link or
// share image at all, because a relative one is not an address a chat client
// can use, and the twitter card falls back to the text-only kind. The
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
	const summaryCard = `<meta name="twitter:card" content="summary" />`
	bare := append(append(append(make([]byte, 0, len(head)+len(summaryCard)+len(tail)), head...), summaryCard...), tail...)
	// The image tags do not depend on the request, so they are built once.
	img := html.EscapeString(base + "/og.png")
	imageTags := "\n    " +
		`<meta property="og:image" content="` + img + `" />` + "\n    " +
		`<meta property="og:image:width" content="1200" />` + "\n    " +
		`<meta property="og:image:height" content="630" />` + "\n    " +
		`<meta property="og:image:alt" content="Parley — two playing cards and the words: pull up a chair, your team's table is ready." />` + "\n    " +
		`<meta name="twitter:card" content="summary_large_image" />` + "\n    " +
		`<meta name="twitter:image" content="` + img + `" />`
	shell := func(r *http.Request) []byte {
		if publicURL == "" {
			return bare
		}
		u := html.EscapeString(base + r.URL.EscapedPath())
		tags := `<meta property="og:url" content="` + u + `" />` + "\n    " +
			`<link rel="canonical" href="` + u + `" />` + imageTags
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
