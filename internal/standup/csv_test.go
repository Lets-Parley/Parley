package standup

import (
	"testing"

	"github.com/lets-parley/parley/internal/session"
)

func env(st any, people ...session.Person) session.Envelope {
	return session.Envelope{Kind: "standup", State: st, Participants: people}
}

func person(id, name string) session.Person {
	return session.Person{UserID: id, Name: name}
}

func TestExportCSVHeaderAndRows(t *testing.T) {
	rows, err := exportCSV(env(
		State{Entries: []WireEntry{
			{UserID: "u1", Yesterday: "shipped the gate", Today: "review", Blockers: "none"},
			{UserID: "u2", Yesterday: "docs", Today: "tests", Blockers: "waiting on CI", Skipped: true},
		}},
		person("u1", "Dana Whitfield"), person("u2", "Marcus Okonjo"),
	))
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"name", "yesterday", "today", "blockers", "skipped"},
		{"Dana Whitfield", "shipped the gate", "review", "none", "false"},
		{"Marcus Okonjo", "docs", "tests", "waiting on CI", "true"},
	}
	if len(rows) != len(want) {
		t.Fatalf("got %d rows, want %d: %v", len(rows), len(want), rows)
	}
	for i := range want {
		for j := range want[i] {
			if rows[i][j] != want[i][j] {
				t.Errorf("row %d col %d = %q, want %q", i, j, rows[i][j], want[i][j])
			}
		}
	}
}

// The export is the one place a standup leaves the app, so a cell that a
// spreadsheet would execute has to arrive quoted.
func TestExportCSVQuotesFormulaCells(t *testing.T) {
	for _, lead := range []string{"=", "+", "-", "@", "\t", "\r"} {
		rows, err := exportCSV(env(
			State{Entries: []WireEntry{{UserID: "u1", Yesterday: lead + "cmd|'/c calc'!A0"}}},
			person("u1", lead+"Dana"),
		))
		if err != nil {
			t.Fatal(err)
		}
		if got := rows[1][1]; got[0] != '\'' {
			t.Errorf("yesterday starting %q not quoted: %q", lead, got)
		}
		if got := rows[1][0]; got[0] != '\'' {
			t.Errorf("name starting %q not quoted: %q", lead, got)
		}
	}
}

func TestExportCSVLeavesOrdinaryCellsAlone(t *testing.T) {
	rows, err := exportCSV(env(
		State{Entries: []WireEntry{{UserID: "u1", Today: "3 + 4 is not a formula"}}},
		person("u1", "Dana Whitfield"),
	))
	if err != nil {
		t.Fatal(err)
	}
	if rows[1][2] != "3 + 4 is not a formula" {
		t.Errorf("ordinary cell was altered: %q", rows[1][2])
	}
}

// A participant can leave the space between writing an update and the export.
// The row is still worth having; it just has no name to put on it.
func TestExportCSVKeepsEntriesWithNoMatchingParticipant(t *testing.T) {
	rows, err := exportCSV(env(
		State{Entries: []WireEntry{{UserID: "ghost", Today: "wrote this before leaving"}}},
	))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want header + 1: %v", len(rows), rows)
	}
	if rows[1][0] != "" {
		t.Errorf("name = %q, want empty for an unknown participant", rows[1][0])
	}
	if rows[1][2] != "wrote this before leaving" {
		t.Errorf("entry body lost: %q", rows[1][2])
	}
}

func TestExportCSVEmptyStandupIsHeaderOnly(t *testing.T) {
	rows, err := exportCSV(env(State{Entries: []WireEntry{}}))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want header only: %v", len(rows), rows)
	}
}

func TestExportCSVPreservesEntryOrder(t *testing.T) {
	rows, err := exportCSV(env(
		State{Entries: []WireEntry{
			{UserID: "u3", Position: 1},
			{UserID: "u1", Position: 2},
			{UserID: "u2", Position: 3},
		}},
		person("u1", "Dana"), person("u2", "Marcus"), person("u3", "Priya"),
	))
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"Priya", "Dana", "Marcus"} {
		if rows[i+1][0] != want {
			t.Errorf("row %d name = %q, want %q — export must not reorder", i+1, rows[i+1][0], want)
		}
	}
}

// The registry hands every kind the same Envelope, so the wrong state type is
// a routing mistake and must be reported rather than exported as an empty file.
func TestExportCSVRejectsForeignState(t *testing.T) {
	for name, st := range map[string]any{
		"poker-shaped": struct{ Stories []string }{},
		"pointer":      &State{},
		"nil":          nil,
	} {
		if _, err := exportCSV(env(st)); err == nil {
			t.Errorf("%s state: expected an error, got none", name)
		}
	}
}
