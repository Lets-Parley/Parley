package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

func patchAvatar(t *testing.T, srv *httptest.Server, body string, cookie *http.Cookie) (*http.Response, map[string]any) {
	t.Helper()
	return doJSON(t, srv, "PATCH", "/api/me/avatar", body, cookie)
}

// TestAvatarReachesEveryWireSurface is the acceptance test for the phase: a
// chosen avatar has to show up wherever a person is rendered, and each of the
// three surfaces reads the columns through a different query.
func TestAvatarReachesEveryWireSurface(t *testing.T) {
	srv := testServer(t)

	resp, _ := postMe(t, srv, "Ada", nil)
	cookie := sessionCookieOf(t, resp)

	if resp, _ := patchAvatar(t, srv, `{"icon":"fox"}`, cookie); resp.StatusCode != http.StatusOK {
		t.Fatalf("patch avatar: got %d", resp.StatusCode)
	}

	_, me := getMe(t, srv, cookie)
	if me["avatarIcon"] != "fox" {
		t.Errorf("GET /api/me = %v", me)
	}
	if _, ok := me["avatarHue"].(float64); !ok {
		t.Errorf("avatarHue must be a number, got %#v", me["avatarHue"])
	}

	_, created := createSpace(t, srv, "Platform", cookie)
	slug := created["slug"].(string)
	_, space := getSpace(t, srv, slug, cookie)
	members := space["members"].([]any)
	first := members[0].(map[string]any)
	if first["avatarIcon"] != "fox" {
		t.Errorf("space member = %v", first)
	}

	_, sess := createSession(t, srv, slug, "poker", "Sprint 1", cookie)
	_, env := doJSON(t, srv, "GET", "/api/sessions/"+sess["id"].(string), "", cookie)
	people := env["participants"].([]any)
	person := people[0].(map[string]any)
	if person["avatarIcon"] != "fox" {
		t.Errorf("participant = %v", person)
	}
	if _, ok := person["avatarHue"].(float64); !ok {
		t.Errorf("participant avatarHue must be a number, got %#v", person["avatarHue"])
	}
}

// TestAvatarDefaultsForAPreExistingUser covers the migration's default: a user
// that predates the avatar columns reports empty ids and a derived hue rather
// than nulls.
func TestAvatarDefaultsForAPreExistingUser(t *testing.T) {
	srv := testServer(t)
	resp, _ := postMe(t, srv, "Grace", nil)
	_, me := getMe(t, srv, sessionCookieOf(t, resp))
	if me["avatarIcon"] != "" {
		t.Errorf("fresh user = %v, want an empty avatar id", me)
	}
	if hue, ok := me["avatarHue"].(float64); !ok || hue < 0 || hue > 359 {
		t.Errorf("avatarHue = %#v, want a derived 0-359 integer", me["avatarHue"])
	}
}

func TestAvatarRejectsMalformedIDs(t *testing.T) {
	srv := testServer(t)
	resp, _ := postMe(t, srv, "Ada", nil)
	cookie := sessionCookieOf(t, resp)

	for _, body := range []string{
		`{"icon":"Fox"}`,
		`{"icon":"fox_cub"}`,
		`{"icon":"../etc"}`,
		`{"icon":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`,
	} {
		if resp, _ := patchAvatar(t, srv, body, cookie); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("patch %s: got %d, want 400", body, resp.StatusCode)
		}
	}
	_, me := getMe(t, srv, cookie)
	if me["avatarIcon"] != "" {
		t.Errorf("a rejected id was written: %v", me)
	}
}

func TestAvatarRequiresASession(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})

	if resp, _ := patchAvatar(t, srv, `{"icon":"fox"}`, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous patch: got %d, want 401", resp.StatusCode)
	}
	var users int
	if err := pool.QueryRow(context.Background(), "select count(*) from users").Scan(&users); err != nil {
		t.Fatal(err)
	}
	if users != 0 {
		t.Errorf("anonymous patch created %d users", users)
	}
}

func TestRenameKeepsTheAvatar(t *testing.T) {
	srv := testServer(t)
	resp, _ := postMe(t, srv, "Ada", nil)
	cookie := sessionCookieOf(t, resp)
	patchAvatar(t, srv, `{"icon":"fox"}`, cookie)

	renamed, body := postMe(t, srv, "Ada L", cookie)
	if renamed.StatusCode != http.StatusOK {
		t.Fatalf("rename: got %d", renamed.StatusCode)
	}
	if body["avatarIcon"] != "fox" {
		t.Errorf("rename returned %v, want the existing avatar", body)
	}
}

func TestAvatarWritableInOIDCMode(t *testing.T) {
	idp := newFakeIdP(t)
	srv := oidcServer(t, idp)
	cookie := signInOIDC(t, srv, idp)

	if resp, _ := patchAvatar(t, srv, `{"icon":"fox"}`, cookie); resp.StatusCode != http.StatusOK {
		t.Errorf("patch avatar in oidc mode: got %d, want 200", resp.StatusCode)
	}
	// The avatar route must not become a way around the provider owning names.
	if resp, _ := postMe(t, srv, "Renamed", cookie); resp.StatusCode != http.StatusForbidden {
		t.Errorf("rename in oidc mode: got %d, want 403", resp.StatusCode)
	}
}

// TestFederatedSignInLeavesTheAvatarAlone guards the one-line omission in
// UpsertFederated's conflict clause: were the avatar columns listed there,
// every OIDC sign-in would reset the person's choice.
func TestFederatedSignInLeavesTheAvatarAlone(t *testing.T) {
	pool := testPool(t)
	users := &store.Users{Pool: pool}
	ctx := context.Background()

	_, firstHash := store.NewToken()
	u, err := users.UpsertFederated(ctx, "https://idp.test", "sub-1", "Ada", firstHash)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := users.SetAvatar(ctx, u.ID, "fox"); err != nil {
		t.Fatal(err)
	}

	_, secondHash := store.NewToken()
	again, err := users.UpsertFederated(ctx, "https://idp.test", "sub-1", "Ada", secondHash)
	if err != nil {
		t.Fatal(err)
	}
	if again.AvatarIcon != "fox" {
		t.Errorf("second sign-in returned %q, want fox", again.AvatarIcon)
	}
	assertAvatarRow(t, pool, u.ID, "fox")
}

func TestSetAvatarReportsWhetherAnythingChanged(t *testing.T) {
	pool := testPool(t)
	users := &store.Users{Pool: pool}
	ctx := context.Background()
	_, hash := store.NewToken()
	u, err := users.Create(ctx, "Ada", hash)
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := users.SetAvatar(ctx, u.ID, "fox"); err != nil || !changed {
		t.Errorf("first write: changed=%v err=%v, want true/nil", changed, err)
	}
	if changed, err := users.SetAvatar(ctx, u.ID, "fox"); err != nil || changed {
		t.Errorf("identical rewrite: changed=%v err=%v, want false/nil", changed, err)
	}
}

func assertAvatarRow(t *testing.T, pool *pgxpool.Pool, userID, icon string) {
	t.Helper()
	var gotIcon string
	if err := pool.QueryRow(context.Background(),
		"select avatar_icon from users where id = $1", userID,
	).Scan(&gotIcon); err != nil {
		t.Fatal(err)
	}
	if gotIcon != icon {
		t.Errorf("users row avatar_icon = %q, want %q", gotIcon, icon)
	}
}

// signInOIDC drives the full provider round trip and returns the resulting
// Parley session cookie.
func signInOIDC(t *testing.T, srv *httptest.Server, idp *fakeIdP) *http.Cookie {
	t.Helper()
	authURL, flow := startSignin(t, srv, "")
	idp.nonce = authURL.Query().Get("nonce")
	resp := callback(t, srv, flow, authURL.Query().Get("state"))
	defer resp.Body.Close()
	return sessionCookieOf(t, resp)
}

// TestAvatarAccessoryIsFrozen pins the breaking change that came with the
// portrait tier: accessories are gone, so an "accessory" in the body is
// accepted for compatibility with older clients and then ignored — nothing
// reaches the retired column, and no surface reports one.
func TestAvatarAccessoryIsFrozen(t *testing.T) {
	pool := testPool(t)
	srv := testServerWith(t, pool, Options{AllowedOrigin: "http://example.test"})

	resp, _ := postMe(t, srv, "Ada", nil)
	cookie := sessionCookieOf(t, resp)

	if resp, patched := patchAvatar(t, srv, `{"icon":"fox","accessory":"scarf"}`, cookie); resp.StatusCode != http.StatusOK {
		t.Fatalf("patch avatar: got %d", resp.StatusCode)
	} else if _, ok := patched["avatarAccessory"]; ok {
		t.Errorf("PATCH response still carries avatarAccessory: %v", patched)
	}

	if _, me := getMe(t, srv, cookie); me["avatarIcon"] != "fox" {
		t.Errorf("GET /api/me = %v", me)
	} else if _, ok := me["avatarAccessory"]; ok {
		t.Errorf("GET /api/me still carries avatarAccessory: %v", me)
	}

	var stored string
	if err := pool.QueryRow(context.Background(),
		"select avatar_accessory from users where name = $1", "Ada").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "" {
		t.Errorf("avatar_accessory = %q, want the column left unwritten", stored)
	}
}
