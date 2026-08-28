package api

import (
	"net/http"
	"testing"

	"github.com/lets-parley/parley/internal/poker"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/standup"
)

// One direction of one invariant: a non-POST action registered here has a
// matching entry in the client's own verb table, web/src/lib/api.ts, which
// defaults everything it does not list to POST. That default is what makes the
// drift silent — register a PUT action, forget the client, and it ships POST to
// a route that answers 405.
//
// This catches server-changed/client-forgotten only. The opposite direction —
// api.ts edited while the registry stays put — is caught by "sends each action
// with the verb the server routes it on" in web/src/lib/api.test.ts. Neither
// test reads the other side's table, so both are needed and both are listed
// here on purpose.
//
// It lives in package api rather than internal/session because poker and
// standup import session; a test there that reached for their kinds would be an
// import cycle.
//
// Adding a non-POST action means three edits: the registry, actionVerbs in
// web/src/lib/api.ts, and clientVerbs below.
func TestNonPostActionsAreMirroredInTheClientVerbTable(t *testing.T) {
	clientVerbs := map[string]string{
		"ready":   http.MethodPut,
		"standup": http.MethodPut,
		"story":   http.MethodPatch,
		"config":  http.MethodPatch,
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
