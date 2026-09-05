package principal

import "testing"

func TestAuditSubject(t *testing.T) {
	cases := []struct {
		name string
		p    Principal
		want string
	}{
		{name: "link guest", p: Principal{LinkSessionID: "sess-1"}, want: "guest"},
		{name: "federated", p: Principal{Subject: "idp-sub"}, want: "idp-sub"},
		{name: "open", p: Principal{}, want: "open"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.p.AuditSubject(); got != tc.want {
				t.Fatalf("AuditSubject() = %q, want %q", got, tc.want)
			}
		})
	}
}
