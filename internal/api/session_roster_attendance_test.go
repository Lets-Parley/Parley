package api

import (
	"net/http"
	"slices"
	"strings"
	"testing"
)

// TestRoomSeatsOnlyPeopleWhoHaveBeenInIt pins the roster rule. A room used to
// seat every member of its space, so somebody who had never opened it appeared
// at the table — which reads to the rest of the room as "they are in this
// meeting". Turning up is what earns a seat.
func TestRoomSeatsOnlyPeopleWhoHaveBeenInIt(t *testing.T) {
	srv := testServer(t)
	fac, mel, id := setupSession(t, srv, "Attendance Space")

	// Fay is the facilitator and is seated without attaching: a room whose
	// owner has not opened a socket yet must not render as empty.
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, env); !slices.Equal(got, []string{"Fay"}) {
		t.Fatalf("participants = %v, want just the facilitator [Fay]", got)
	}

	attend(t, srv, id, testOrigin, mel)

	// And the seat survives the socket closing: leaving the room is not
	// leaving the meeting.
	_, env = doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, env); !slices.Equal(got, []string{"Fay", "Mel"}) {
		t.Fatalf("participants = %v, want [Fay Mel] once Mel has been here", got)
	}
}

// TestAVoteSeatsItsVoter is the belt to the participants row's braces: whatever
// path recorded a vote, the person who cast it is on the roster, so no export
// can carry an estimate with no name against it.
func TestAVoteSeatsItsVoter(t *testing.T) {
	srv := testServer(t)
	fac, mel, id := setupSession(t, srv, "Voter Seat Space")
	story := addStory(t, srv, id, "Story", fac)
	selectStory(t, srv, id, story, fac)

	if resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/vote",
		`{"storyId":"`+story+`","value":"5"}`, mel); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: got %d, want 204 (%v)", resp.StatusCode, body)
	}

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, env); !slices.Equal(got, []string{"Fay", "Mel"}) {
		t.Fatalf("participants = %v, want the voter seated [Fay Mel]", got)
	}
}

// TestARemovedMembersVoteKeepsItsName is the guarantee the roster comment
// makes, at its hardest point. A vote is a record the room holds, so the
// person who cast it stays seated even after their membership is pulled —
// otherwise the export carries an estimate with nobody's name against it.
func TestARemovedMembersVoteKeepsItsName(t *testing.T) {
	srv := testServer(t)
	fac := signup(t, srv, "Fay")
	mel, melID := signupWithID(t, srv, "Mel")
	_, sp := createSpace(t, srv, "Removed Voter Space", fac)
	slug := sp["slug"].(string)
	if resp := joinSpace(t, srv, slug, mel, sp["passcode"].(string)); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("join: %d", resp.StatusCode)
	}
	_, sess := createSession(t, srv, slug, "poker", "Sprint 12", fac)
	id := sess["id"].(string)

	story := addStory(t, srv, id, "Story", fac)
	selectStory(t, srv, id, story, fac)
	if resp := vote(t, srv, id, story, "5", mel); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}
	doJSON(t, srv, "POST", "/api/sessions/"+id+"/actions/reveal", "", fac)

	if resp, body := removeMember(t, srv, slug, melID, fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove Mel: got %d (%s)", resp.StatusCode, body)
	}

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, env); !slices.Equal(got, []string{"Fay", "Mel"}) {
		t.Fatalf("participants = %v, want the removed voter still named [Fay Mel]", got)
	}
	if _, body := fetchCSV(t, srv, id, fac); !strings.Contains(body, "Mel: 5") {
		t.Fatalf("export lost the removed voter's name:\n%s", body)
	}
}

// TestASpectatorVoterGetsOneSeat guards the seam the record branch opens. The
// roster is a UNION, which dedupes whole rows and not people, so a member who
// is both seated by their own row and seated again by something they left
// behind must present the same spectator flag from both — or the room draws
// two of them and every vote denominator counts them twice.
func TestASpectatorVoterGetsOneSeat(t *testing.T) {
	srv := testServer(t)
	fac, mel, id := setupSession(t, srv, "Spectator Voter Space")
	// Mel turns up, so the members branch seats her as well as the record
	// branch: this is the state where two branches can both fire for one
	// person, and the only state where they can disagree.
	attend(t, srv, id, testOrigin, mel)
	story := addStory(t, srv, id, "Story", fac)
	selectStory(t, srv, id, story, fac)
	if resp := vote(t, srv, id, story, "5", mel); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("vote: %d", resp.StatusCode)
	}
	// Sitting out does not retract the vote already cast, so this is the
	// state where the two branches disagree if the flag is not shared.
	if resp, body := doJSON(t, srv, "POST", "/api/sessions/"+id+"/spectator", `{"on":true}`, mel); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("spectate: got %d (%v)", resp.StatusCode, body)
	}

	_, env := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if got := participantNames(t, env); !slices.Equal(got, []string{"Fay", "Mel"}) {
		t.Fatalf("participants = %v, want one seat each [Fay Mel]", got)
	}
	for _, p := range env["participants"].([]any) {
		row := p.(map[string]any)
		if row["name"] == "Mel" && row["spectator"] != true {
			t.Fatalf("Mel seated as spectator=%v, want the member's own flag to win", row["spectator"])
		}
	}
}
