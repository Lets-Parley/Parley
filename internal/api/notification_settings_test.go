package api

import (
	"net/http"
	"testing"
)

func TestNotificationSoundsRoundTripWithoutRotatingToken(t *testing.T) {
	srv := testServer(t)
	ada := signup(t, srv, "Ada")
	mel := signup(t, srv, "Mel")

	resp, body := doJSON(t, srv, http.MethodPatch, "/api/me/settings", `{"notificationSounds":true}`, ada)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH /api/me/settings: got %d (%v)", resp.StatusCode, body)
	}
	if body["notificationSounds"] != true {
		t.Fatalf("notificationSounds = %v, want true", body["notificationSounds"])
	}
	for _, cookie := range resp.Cookies() {
		if cookie.Name == sessionCookie {
			t.Fatal("settings update rotated the session token")
		}
	}

	_, got := doJSON(t, srv, http.MethodGet, "/api/me", "", ada)
	if got["notificationSounds"] != true {
		t.Errorf("saved setting = %v, want true", got["notificationSounds"])
	}
	_, other := doJSON(t, srv, http.MethodGet, "/api/me", "", mel)
	if other["notificationSounds"] != false {
		t.Errorf("another user's setting = %v, want false", other["notificationSounds"])
	}

	resp, body = doJSON(t, srv, http.MethodPatch, "/api/me/settings", `{"notificationSounds":false}`, ada)
	if resp.StatusCode != http.StatusOK || body["notificationSounds"] != false {
		t.Fatalf("disabling sounds: got %d, body %v", resp.StatusCode, body)
	}
}

func TestNotificationSoundsSurviveProfileChanges(t *testing.T) {
	srv := testServer(t)
	cookie := signup(t, srv, "Ada")
	if resp, body := doJSON(t, srv, http.MethodPatch, "/api/me/settings", `{"notificationSounds":true}`, cookie); resp.StatusCode != http.StatusOK {
		t.Fatalf("enable sounds: got %d (%v)", resp.StatusCode, body)
	}
	if resp, body := doJSON(t, srv, http.MethodPatch, "/api/me/avatar", `{"icon":"ada"}`, cookie); resp.StatusCode != http.StatusOK || body["notificationSounds"] != true {
		t.Fatalf("avatar update lost setting: got %d (%v)", resp.StatusCode, body)
	}
	resp, body := doJSON(t, srv, http.MethodPost, "/api/me", `{"name":"Ada Lovelace"}`, cookie)
	if resp.StatusCode != http.StatusOK || body["notificationSounds"] != true {
		t.Fatalf("rename lost setting: got %d (%v)", resp.StatusCode, body)
	}
}

func TestNotificationSettingsRequiresExplicitBooleanAndIdentity(t *testing.T) {
	srv := testServer(t)
	user := signup(t, srv, "Ada")
	for _, body := range []string{`{}`, `{"notificationSounds":null}`, `{"notificationSounds":"yes"}`} {
		if resp, _ := doJSON(t, srv, http.MethodPatch, "/api/me/settings", body, user); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("body %s: got %d, want 400", body, resp.StatusCode)
		}
	}
	if resp, _ := doJSON(t, srv, http.MethodPatch, "/api/me/settings", `{"notificationSounds":true}`, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("anonymous: got %d, want 401", resp.StatusCode)
	}
}
