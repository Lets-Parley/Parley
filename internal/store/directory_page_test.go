package store

import "testing"

// The bound on the org directory is a promise the server makes about its own
// work, so it holds for every ask — including the ones no client would make.
// This is the half of that promise a database test cannot see cheaply: proving
// the maximum by listing 201 spaces would cost a fifth of a second per run to
// re-assert one comparison.
func TestClampDirectoryPageSize(t *testing.T) {
	for _, tc := range []struct {
		asked int
		want  int
	}{
		{0, DirectoryPageSize},
		{-1, DirectoryPageSize},
		{1, 1},
		{DirectoryMaxPageSize, DirectoryMaxPageSize},
		{DirectoryMaxPageSize + 1, DirectoryMaxPageSize},
		{1 << 30, DirectoryMaxPageSize},
	} {
		if got := ClampDirectoryPageSize(tc.asked); got != tc.want {
			t.Errorf("ClampDirectoryPageSize(%d) = %d, want %d", tc.asked, got, tc.want)
		}
	}
}

// A cursor is (name, slug) and names are arbitrary text, so the encoding has
// to survive whatever somebody called their room. The separator is a NUL,
// which a space name cannot contain, and the round trip has to keep the two
// halves apart even when the name is full of the characters that would break
// a naive delimiter.
func TestDirectoryCursorRoundTrip(t *testing.T) {
	for _, name := range []string{"", "Platform Team", "a=b&c", "slug/looking-name", "emoji 🚢", "  padded  "} {
		cursor := encodeCursor(name, "the-slug")
		gotName, gotSlug, err := decodeCursor(cursor)
		if err != nil {
			t.Fatalf("decoding a cursor for %q: %v", name, err)
		}
		if gotName != name || gotSlug != "the-slug" {
			t.Errorf("round trip of %q = (%q, %q)", name, gotName, gotSlug)
		}
	}
}

// An `after` this build did not mint is refused rather than read as a
// position: guessing would start the caller somewhere they did not ask for and
// look like the list had reset under them.
func TestDirectoryCursorRefusesJunk(t *testing.T) {
	for _, junk := range []string{"not base64!", "bmFtZQ", encodeCursor("name", "")} {
		if _, _, err := decodeCursor(junk); err != ErrBadCursor {
			t.Errorf("decodeCursor(%q) error = %v, want ErrBadCursor", junk, err)
		}
	}
}
