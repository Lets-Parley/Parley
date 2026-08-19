package api

import (
	"net/http"
	"testing"

	"github.com/lets-parley/parley/internal/poker"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/standup"
)

// The client picks an action's verb from a table it keeps itself, in
// web/src/lib/api.ts, defaulting to POST for anything not listed. That default
// is what makes drift silent: register a PUT action here, forget the client,
// and it ships sending POST to a route that answers 405. Nothing else ties the
// two files together, so this test is the tie.
//
// Adding a non-POST action means adding it in BOTH places: the entry below and
// the actionVerbs map in web/src/lib/api.ts.
func TestNonPostActionsAreMirroredInTheClientVerbTable(t *testing.T) {
	clientVerbs := map[string]string{
		"standup": http.MethodPut,
		"story":   http.MethodPatch,
	}
	for _, k := range []session.Kind{poker.Kind(), standup.Kind()} {
		for name, a := range k.Actions {
			if a.Verb == http.MethodPost {
				continue
			}
			if clientVerbs[name] != a.Verb {
				t.Errorf("kind %q action %q answers %s, but web/src/lib/api.ts sends %s — add it to actionVerbs there and to clientVerbs here",
					k.Name, name, a.Verb, cmpOr(clientVerbs[name], http.MethodPost))
			}
		}
	}
}

func cmpOr(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
