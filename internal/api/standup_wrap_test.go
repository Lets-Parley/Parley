package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestStandupWrapUpExtendsOnlyTheExpiredCurrentTurn(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	fac, member, _, id, _ := standupSetup(t, srv, "Standup wrap up")
	for _, socket := range connectAll(t, srv, id, fac, member) {
		t.Cleanup(func() { socket.Close() })
	}
	room := "/api/sessions/" + id
	action := room + "/actions/wrap-up"
	if resp, _ := doJSON(t, srv, "POST", room+"/actions/start", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("start = %d", resp.StatusCode)
	}
	read := func() map[string]any {
		_, env := doJSON(t, srv, "GET", room, "", fac)
		return standupState(env)
	}
	body := func(st map[string]any) string {
		value, _ := json.Marshal(map[string]any{"speakerStartedAt": st["speakerStartedAt"]})
		return string(value)
	}
	first := read()
	post := func(actor *http.Cookie, request string, want int) {
		t.Helper()
		if resp, got := doJSON(t, srv, "POST", action, request, actor); resp.StatusCode != want {
			t.Fatalf("wrap-up = %d, want %d: %v", resp.StatusCode, want, got)
		}
	}
	post(fac, body(first), http.StatusConflict)
	if _, err := pool.Exec(context.Background(), "update sessions set speaker_started_at = now() - interval '3 minutes' where id = $1", id); err != nil {
		t.Fatal(err)
	}
	expired := read()
	request := body(expired)
	post(member, request, http.StatusForbidden)
	post(fac, body(first), http.StatusConflict)
	requestedAt := time.Now()
	post(fac, request, http.StatusNoContent)
	extended := read()
	wrapUntil, ok := extended["speakerWrapUntil"].(string)
	if !ok || extended["speakerStartedAt"] != expired["speakerStartedAt"] {
		t.Fatalf("wrap-up did not extend the original turn: %v", extended)
	}
	deadline, err := time.Parse(time.RFC3339Nano, wrapUntil)
	if err != nil || deadline.Before(requestedAt.Add(29*time.Second)) || deadline.After(time.Now().Add(31*time.Second)) {
		t.Fatalf("unexpected wrap-up deadline %q: %v", wrapUntil, err)
	}
	post(fac, request, http.StatusNoContent)
	if got := read()["speakerWrapUntil"]; got != extended["speakerWrapUntil"] {
		t.Fatalf("retry moved deadline again: %v", got)
	}
	// A previous replica can advance without clearing the new columns.
	if _, err := pool.Exec(context.Background(), "update sessions set speaker_started_at = now() - interval '2 minutes' where id = $1", id); err != nil {
		t.Fatal(err)
	}
	anotherTurn := read()
	if got := anotherTurn["speakerWrapUntil"]; got != nil {
		t.Fatalf("new turn inherited an older deadline: %v", got)
	}
	post(fac, body(anotherTurn), http.StatusNoContent)
	if got := read()["speakerWrapUntil"]; got == nil || got == wrapUntil {
		t.Fatalf("new wrap-up kept the older deadline: %v", got)
	}
	if resp, _ := doJSON(t, srv, "POST", room+"/actions/next", "", fac); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("next = %d", resp.StatusCode)
	}
	if got := read()["speakerWrapUntil"]; got != nil {
		t.Fatalf("next speaker inherited wrap-up: %v", got)
	}
	post(fac, request, http.StatusConflict)
}
