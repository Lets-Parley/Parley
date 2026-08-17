package session

import (
	"fmt"
	"strings"
)

// CSVFunc renders a session's export rows from its WIRE envelope — never from
// raw storage — so anything redacted from the envelope is structurally absent
// from the export too.
type CSVFunc func(env Envelope) ([][]string, error)

var csvFuncs = map[string]CSVFunc{}

func RegisterCSV(kind string, fn CSVFunc) {
	csvFuncs[kind] = fn
}

func CSVRows(env Envelope) ([][]string, error) {
	fn, ok := csvFuncs[env.Kind]
	if !ok {
		return nil, fmt.Errorf("no export for session kind %q", env.Kind)
	}
	return fn(env)
}

// SanitizeCell neutralizes spreadsheet formula injection: a cell starting with
// = + - @ tab or CR gets a leading apostrophe.
func SanitizeCell(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}

// SanitizeFilename keeps a conservative charset for Content-Disposition.
func SanitizeFilename(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ', r == '-', r == '_':
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "session"
	}
	return out
}
