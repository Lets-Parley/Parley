package auth

import (
	"context"
	"slices"
	"testing"
)

// signInWith runs a whole sign-in against the fake provider and hands back the
// identity it produced, so the claim shapes are exercised through the same
// verification production uses rather than against a parser in isolation.
func signInWith(t *testing.T, orgClaim string, extra map[string]any) Identity {
	t.Helper()
	idp := newFakeIdP(t)
	idp.extra = extra
	idp.nonce = "n-1"
	p := New(Config{
		Issuer:      idp.URL,
		ClientID:    "parley-test",
		RedirectURL: "http://example.test/auth/callback",
		OrgClaim:    orgClaim,
	})
	ident, err := p.Exchange(context.Background(), "code", "verifier", "n-1")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	return ident
}

func TestExchangeReadsTheOrgClaimInEveryShape(t *testing.T) {
	for _, tc := range []struct {
		name  string
		claim string
		extra map[string]any
		want  []string
	}{
		{"an array of strings", "", map[string]any{"groups": []any{"platform", "design"}}, []string{"platform", "design"}},
		{"a bare string", "", map[string]any{"groups": "platform"}, []string{"platform"}},
		{"absent", "", nil, nil},
		{"null", "", map[string]any{"groups": nil}, nil},
		{"an empty string", "", map[string]any{"groups": ""}, nil},
		{"a configured claim name", "roles", map[string]any{"roles": []any{"platform"}, "groups": []any{"ignored"}}, []string{"platform"}},
		// A provider that sends numbers or objects in the array is not a
		// reason to fail a sign-in, and not a reason to invent a value.
		{"mixed types", "", map[string]any{"groups": []any{"platform", 7, map[string]any{"id": "x"}}}, []string{"platform"}},
		// Entra's >200-group overage: the claim is replaced by a pointer to
		// the Graph API, so there is nothing to map. Nobody gains membership.
		{"an Entra overage pointer", "", map[string]any{
			"_claim_names":   map[string]any{"groups": "src1"},
			"_claim_sources": map[string]any{"src1": map[string]any{"endpoint": "https://graph.microsoft.com/v1.0/me/getMemberObjects"}},
		}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := signInWith(t, tc.claim, tc.extra).OrgClaims
			if !slices.Equal(got, tc.want) {
				t.Errorf("OrgClaims = %v, want %v", got, tc.want)
			}
		})
	}
}
