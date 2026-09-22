package standup

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// rfc5545Fixture is a hand-written calendar for one open async window.
// Line lengths, the fold in DESCRIPTION, and the TEXT escape in SUMMARY were
// counted by hand. Nothing in this file asks the package to produce the
// expectation.
const rfc5545Fixture = "BEGIN:VCALENDAR\r\n" +
	"VERSION:2.0\r\n" +
	"PRODID:-//Parley//Async standup//EN\r\n" +
	"CALSCALE:GREGORIAN\r\n" +
	"METHOD:PUBLISH\r\n" +
	"BEGIN:VEVENT\r\n" +
	"UID:standup-11111111-1111-4111-8111-111111111111@parley\r\n" +
	"DTSTAMP:20260923T143000Z\r\n" +
	"DTSTART:20260923T140000Z\r\n" +
	"DTEND:20260923T150000Z\r\n" +
	"SUMMARY:Platform\\, East standup\r\n" +
	"DESCRIPTION:https://parley.example/session/11111111-1111-4111-8111-11111111\r\n" +
	" 1111\r\n" +
	"BEGIN:VALARM\r\n" +
	"ACTION:DISPLAY\r\n" +
	"DESCRIPTION:Standup\r\n" +
	"TRIGGER:-PT15M\r\n" +
	"END:VALARM\r\n" +
	"END:VEVENT\r\n" +
	"END:VCALENDAR\r\n"

// TestEscapeTextLiterals checks escapeText against literals computed by
// hand from RFC 5545 section 3.3.11, not against anything the function
// itself produced.
func TestEscapeTextLiterals(t *testing.T) {
	cases := []struct{ in, want string }{
		{";", `\;`},
		{`\`, `\\`},
		{"\n", `\n`},
	}
	for _, c := range cases {
		if got := escapeText(c.in); got != c.want {
			t.Errorf("escapeText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestFoldLineMultibyteBoundary is a line where a 3-byte rune (€, E2 82 AC)
// straddles the 75-octet fold point: 74 ASCII bytes put the naive cut at
// byte index 75, which is the continuation byte E2 82 [AC] — the walk-back
// must land on index 74, the lead byte, instead of splitting the rune.
// Expected output below was counted by hand, not produced by foldLine.
func TestFoldLineMultibyteBoundary(t *testing.T) {
	line := strings.Repeat("a", 74) + "€" + "bb"
	want := strings.Repeat("a", 74) + "\r\n " + "€bb"
	got := foldLine(line)
	if got != want {
		t.Fatalf("foldLine mismatch\n got:  %q\n want: %q", got, want)
	}
	for i, part := range strings.Split(got, "\r\n") {
		if n := len(part); n > 75 {
			t.Errorf("folded line %d is %d octets, want <= 75: %q", i, n, part)
		}
		if !utf8.ValidString(part) {
			t.Errorf("folded line %d is not valid UTF-8: %q", i, part)
		}
	}
}

func TestCalendarMatchesRFC5545Fixture(t *testing.T) {
	got := RenderCalendar(time.Date(2026, 9, 23, 14, 30, 0, 0, time.UTC), 15, []CalendarEvent{{
		UID:     "standup-11111111-1111-4111-8111-111111111111@parley",
		Start:   time.Date(2026, 9, 23, 14, 0, 0, 0, time.UTC),
		End:     time.Date(2026, 9, 23, 15, 0, 0, 0, time.UTC),
		Summary: "Platform, East standup",
		Link:    "https://parley.example/session/11111111-1111-4111-8111-111111111111",
	}})
	if got != rfc5545Fixture {
		t.Fatalf("calendar mismatch\n got:\n%s\nwant:\n%s", strings.ReplaceAll(got, "\r", "\\r"), strings.ReplaceAll(rfc5545Fixture, "\r", "\\r"))
	}
}
