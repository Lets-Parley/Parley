package poker

import "testing"

func TestStoryIdentityError(t *testing.T) {
	cases := []struct {
		name, title, ref string
		wantErr          bool
	}{
		{name: "ref only", ref: "PAR-142"},
		{name: "title only", title: "Rate limiting"},
		{name: "both", title: "Rate limiting", ref: "PAR-142"},
		{name: "neither", wantErr: true},
		{name: "title too long", title: string(make([]byte, 201)), wantErr: true},
		{name: "ref too long", ref: string(make([]byte, 41)), wantErr: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := storyIdentityError(c.title, c.ref)
			if (got != "") != c.wantErr {
				t.Fatalf("storyIdentityError(%q, %q) = %q, wantErr %v", c.title, c.ref, got, c.wantErr)
			}
		})
	}
}
