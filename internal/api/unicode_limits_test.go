package api

import (
	"net/http"
	"strings"
	"testing"
)

// The client counts characters (maxLength={64}) and the columns count
// characters (char_length(name) between 1 and 64), so the handlers have to
// count characters too. A name of multi-byte runes is the case where a byte
// count silently disagrees with both.

func repeatRunes(r string, n int) string { return strings.Repeat(r, n) }

func TestSignUpAcceptsSixtyFourMultiByteCharacters(t *testing.T) {
	srv := testServer(t)

	name := repeatRunes("い", 64)
	resp, body := postMe(t, srv, name, nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: got %d, want 201 (%v)", resp.StatusCode, body)
	}
	if body["name"] != name {
		t.Fatalf("name = %v, want the name as sent", body["name"])
	}

	resp, body = getMe(t, srv, sessionCookieOf(t, resp))
	if resp.StatusCode != http.StatusOK || body["name"] != name {
		t.Fatalf("me: got %d %v, want the persisted name", resp.StatusCode, body)
	}
}

func TestSignUpRejectsSixtyFiveMultiByteCharacters(t *testing.T) {
	srv := testServer(t)

	resp, body := postMe(t, srv, repeatRunes("い", 65), nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("create: got %d, want 400 (%v)", resp.StatusCode, body)
	}
}

func TestRenameAcceptsSixtyFourMultiByteCharacters(t *testing.T) {
	srv := testServer(t)
	cookie := signup(t, srv, "Ada")

	name := repeatRunes("い", 64)
	resp, body := postMe(t, srv, name, cookie)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename: got %d, want 200 (%v)", resp.StatusCode, body)
	}
	if body["name"] != name {
		t.Fatalf("name = %v, want the name as sent", body["name"])
	}
}

func TestCreateSpaceAcceptsSixtyFourMultiByteCharacters(t *testing.T) {
	srv := testServer(t)
	cookie := signup(t, srv, "Ada")

	// One ASCII letter so the slug is not empty; the rest multi-byte.
	name := "a" + repeatRunes("é", 63)
	resp, body := createSpace(t, srv, name, cookie)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create space: got %d, want 201 (%v)", resp.StatusCode, body)
	}
	if body["name"] != name {
		t.Fatalf("name = %v, want the name as sent", body["name"])
	}

	resp, body = createSpace(t, srv, "a"+repeatRunes("é", 64), cookie)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("65-character space name: got %d, want 400 (%v)", resp.StatusCode, body)
	}
}

func TestRenameSpaceAcceptsSixtyFourMultiByteCharacters(t *testing.T) {
	srv := testServer(t)
	cookie := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Renames", cookie)
	slug := sp["slug"].(string)

	name := repeatRunes("い", 64)
	resp, body := doJSON(t, srv, "PATCH", "/api/spaces/"+slug, `{"name":"`+name+`"}`, cookie)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename space: got %d, want 200 (%v)", resp.StatusCode, body)
	}

	resp, body = getSpace(t, srv, slug, cookie)
	if resp.StatusCode != http.StatusOK || body["name"] != name {
		t.Fatalf("space: got %d %v, want the persisted name", resp.StatusCode, body)
	}

	resp, body = doJSON(t, srv, "PATCH", "/api/spaces/"+slug, `{"name":"`+repeatRunes("い", 65)+`"}`, cookie)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("65-character rename: got %d, want 400 (%v)", resp.StatusCode, body)
	}
}

func TestRedeemLinkAcceptsSixtyFourMultiByteCharacters(t *testing.T) {
	srv := testServer(t)
	fac, _, sessionID := setupSession(t, srv, "Link Unicode")
	_, minted := mintLink(t, srv, sessionID, fac)
	token := minted["token"].(string)

	name := repeatRunes("い", 64)
	resp, body, _ := redeem(t, srv, token, name)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("redeem: got %d, want 201 (%v)", resp.StatusCode, body)
	}
}

func TestRedeemLinkRejectsSixtyFiveMultiByteCharacters(t *testing.T) {
	srv := testServer(t)
	fac, _, sessionID := setupSession(t, srv, "Link Unicode Reject")
	_, minted := mintLink(t, srv, sessionID, fac)
	token := minted["token"].(string)

	// Name validation runs before the token is looked up, so this token is
	// still unused after the rejection below and does not need to be re-minted.
	resp, body, _ := redeem(t, srv, token, repeatRunes("い", 65))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("65-character redeem name: got %d, want 400 (%v)", resp.StatusCode, body)
	}
}

func TestRoomTitleAcceptsTwoHundredMultiByteCharacters(t *testing.T) {
	srv := testServer(t)
	cookie := signup(t, srv, "Ada")
	_, sp := createSpace(t, srv, "Titles", cookie)
	slug := sp["slug"].(string)

	title := repeatRunes("い", 200)
	resp, body := createSession(t, srv, slug, "poker", title, cookie)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create room: got %d, want 201 (%v)", resp.StatusCode, body)
	}
	id := body["id"].(string)

	resp, body = createSession(t, srv, slug, "poker", repeatRunes("い", 201), cookie)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("201-character title: got %d, want 400 (%v)", resp.StatusCode, body)
	}

	renamed := "ま" + repeatRunes("い", 199)
	resp, body = doJSON(t, srv, "PATCH", "/api/spaces/"+slug+"/sessions/"+id, `{"title":"`+renamed+`"}`, cookie)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename room: got %d, want 200 (%v)", resp.StatusCode, body)
	}
	if body["title"] != renamed {
		t.Fatalf("title = %v, want the title as sent", body["title"])
	}

	resp, body = doJSON(t, srv, "PATCH", "/api/spaces/"+slug+"/sessions/"+id, `{"title":"`+repeatRunes("い", 201)+`"}`, cookie)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("201-character rename: got %d, want 400 (%v)", resp.StatusCode, body)
	}
}
