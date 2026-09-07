package api

import (
	"net/http"
	"slices"
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
