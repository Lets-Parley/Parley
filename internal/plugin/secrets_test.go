package plugin

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/lets-parley/parley/internal/standup"
)

const (
	oldSecretKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
	newSecretKey = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA="
)

// clearSecrets empties both sealed tables, since ResealSecrets counts across
// the whole database and other tests leave rows behind.
func clearSecrets(t *testing.T, pool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), "delete from plugin_secrets; delete from standup_webhooks; delete from secret_binding"); err != nil {
		t.Fatal(err)
	}
}

// bindSecrets records the marker "parley secrets reseal" writes, so writes
// use the bound form. It is removed again when the test ends.
func bindSecrets(t *testing.T, pool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), "insert into secret_binding default values on conflict do nothing"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), "delete from secret_binding") })
}

func mustCipher(t *testing.T, cur, prev string) *Cipher {
	t.Helper()
	c, err := NewRotatingCipher(cur, prev)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestASecretRowSwappedBetweenInstallsOrTablesDoesNotOpen(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	s := &Store{Pool: pool, Cipher: mustCipher(t, oldSecretKey, "")}
	bindSecrets(t, pool)
	a := install(t, s, Grant{Capability: CapabilitySecrets})
	b := install(t, s, Grant{Capability: CapabilitySecrets})
	if err := s.PutSecret(ctx, a.ID, "token", "alpha"); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSecret(ctx, b.ID, "token", "bravo"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		update plugin_secrets p set nonce = q.nonce, ciphertext = q.ciphertext, key_id = q.key_id
		from plugin_secrets q where p.install_id = $1 and q.install_id = $2 and p.name = q.name`, b.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if v, err := s.GetSecret(ctx, b.ID, "token"); !errors.Is(err, ErrSecretUndecryptable) {
		t.Fatalf("install b read install a's row as (%q, %v), want ErrSecretUndecryptable", v, err)
	}

	nonce, sealed, keyID, err := s.SealWebhook(ctx, a.ID, "webhook-secret")
	if err != nil {
		t.Fatal(err)
	}
	if v, err := s.Cipher.Open(keyID, pluginSecretAAD(a.ID, "token"), nonce, sealed); !errors.Is(err, ErrSecretUndecryptable) {
		t.Fatalf("a webhook row opened as a plugin secret: (%q, %v)", v, err)
	}
}

func TestRotationWithThePreviousKeyReadsAndReseals(t *testing.T) {
	pool := testPool(t)
	clearSecrets(t, pool)
	ctx := context.Background()
	old := &Store{Pool: pool, Cipher: mustCipher(t, oldSecretKey, "")}
	in := install(t, old, Grant{Capability: CapabilitySecrets})
	if err := old.PutSecret(ctx, in.ID, "sealed", "one"); err != nil {
		t.Fatal(err)
	}
	// A row from before key ids: no additional data, no key_id.
	nonce := make([]byte, 12)
	legacy := old.Cipher.cur.aead.Seal(nil, nonce, []byte("two"), nil)
	if _, err := pool.Exec(ctx, `insert into plugin_secrets (install_id, name, nonce, ciphertext) values ($1, 'legacy', $2, $3)`, in.ID, nonce, legacy); err != nil {
		t.Fatal(err)
	}

	rotated := &Store{Pool: pool, Cipher: mustCipher(t, newSecretKey, oldSecretKey)}
	for name, want := range map[string]string{"sealed": "one", "legacy": "two"} {
		if v, err := rotated.GetSecret(ctx, in.ID, name); err != nil || v != want {
			t.Fatalf("%s under the rotated cipher = (%q, %v), want %q", name, v, err, want)
		}
	}
	resealed, remaining, err := rotated.ResealSecrets(ctx)
	if err != nil || resealed != 2 || remaining != 0 {
		t.Fatalf("ResealSecrets = (%d, %d, %v), want (2, 0, nil)", resealed, remaining, err)
	}
	var onNew int
	if err := pool.QueryRow(ctx, `select count(*) from plugin_secrets where install_id = $1 and key_id = $2`, in.ID, rotated.Cipher.KeyID()).Scan(&onNew); err != nil || onNew != 2 {
		t.Fatalf("%d rows on the new key id (%v), want 2", onNew, err)
	}
	newOnly := &Store{Pool: pool, Cipher: mustCipher(t, newSecretKey, "")}
	for name, want := range map[string]string{"sealed": "one", "legacy": "two"} {
		if v, err := newOnly.GetSecret(ctx, in.ID, name); err != nil || v != want {
			t.Fatalf("%s after re-seal without the previous key = (%q, %v), want %q", name, v, err, want)
		}
	}
	if resealed, _, _ := newOnly.ResealSecrets(ctx); resealed != 0 {
		t.Fatalf("a second pass re-sealed %d rows, want 0", resealed)
	}
}

func TestRotationWithoutThePreviousKeyIsUndecryptableNotMissing(t *testing.T) {
	pool := testPool(t)
	clearSecrets(t, pool)
	ctx := context.Background()
	old := &Store{Pool: pool, Cipher: mustCipher(t, oldSecretKey, "")}
	in := install(t, old, Grant{Capability: CapabilitySecrets})
	if err := old.PutSecret(ctx, in.ID, "token", "one"); err != nil {
		t.Fatal(err)
	}
	rotated := &Store{Pool: pool, Cipher: mustCipher(t, newSecretKey, "")}
	if _, err := rotated.GetSecret(ctx, in.ID, "token"); !errors.Is(err, ErrSecretUndecryptable) || errors.Is(err, ErrSecretNotSet) {
		t.Fatalf("GetSecret after an unprepared rotation = %v, want ErrSecretUndecryptable", err)
	}
	if _, err := rotated.GetSecret(ctx, in.ID, "absent"); !errors.Is(err, ErrSecretNotSet) {
		t.Fatalf("GetSecret of an absent name = %v, want ErrSecretNotSet", err)
	}
	if resealed, remaining, err := rotated.ResealSecrets(ctx); err != nil || resealed != 0 || remaining != 1 {
		t.Fatalf("ResealSecrets = (%d, %d, %v), want (0, 1, nil)", resealed, remaining, err)
	}
}

func TestAPreviousKeyEqualToTheCurrentOneIsRefused(t *testing.T) {
	if _, err := NewRotatingCipher(oldSecretKey, oldSecretKey); err == nil {
		t.Fatal("a previous key equal to the current key was accepted")
	}
	if _, err := NewRotatingCipher(oldSecretKey, "not base64"); err == nil {
		t.Fatal("a malformed previous key was accepted")
	}
}

func TestWebhookSigningSurvivesRotation(t *testing.T) {
	pool := redirectTestPool(t)
	ctx := context.Background()
	var body []byte
	var sig string
	hooks := func(c *Cipher) *standup.Webhooks {
		st := &Store{Pool: pool, Cipher: c}
		return &standup.Webhooks{
			Pool: pool, BaseURL: "https://parley.example", Seal: st.SealWebhook, Open: st.OpenWebhook,
			Send: func(_ context.Context, _ string, h map[string]string, b []byte) (int, error) {
				body, sig = b, h["X-Parley-Signature"]
				return 200, nil
			},
		}
	}
	var spaceID, userID string
	if err := pool.QueryRow(ctx, "insert into spaces (slug, name) values ('rotate', 'Rotate') returning id::text").Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Ada') returning id::text").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := hooks(mustCipher(t, oldSecretKey, "")).Put(ctx, spaceID, "", "https://hooks.example/in", "s3cret"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "update standup_webhooks set created_at = now() - interval '1 minute'"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'standup', 'Daily', '{"mode":"async"}', $2)`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	rotated := &Store{Pool: pool, Cipher: mustCipher(t, newSecretKey, oldSecretKey)}
	if resealed, remaining, err := rotated.ResealSecrets(ctx); err != nil || resealed != 1 || remaining != 0 {
		t.Fatalf("ResealSecrets = (%d, %d, %v), want (1, 0, nil)", resealed, remaining, err)
	}
	h := hooks(mustCipher(t, newSecretKey, ""))
	if err := h.Enqueue(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.Deliver(ctx); err != nil {
		t.Fatal(err)
	}
	if body == nil || sig != standup.SignWebhook("s3cret", body) {
		t.Fatalf("delivery after rotation signed %q over %q, want the original secret's signature", sig, body)
	}
}

func TestTheKeyIDIsAFixedFingerprintOfTheKey(t *testing.T) {
	// HMAC-SHA256(key, "parley-secret-key-id-v1")[:8], computed with openssl.
	if got := mustCipher(t, oldSecretKey, "").KeyID(); got != "7b0c5e9172d53094" {
		t.Fatalf("KeyID() = %q, want 7b0c5e9172d53094", got)
	}
}

func TestASecretSealedForOneNameOrSpaceDoesNotOpenForAnother(t *testing.T) {
	c := mustCipher(t, oldSecretKey, "")
	n, ct, kid, err := c.Seal(pluginSecretAAD("install", "a"), "v")
	if err != nil {
		t.Fatal(err)
	}
	if v, err := c.Open(kid, pluginSecretAAD("install", "b"), n, ct); err == nil {
		t.Fatalf("secret a opened as secret b: %q", v)
	}
	n, ct, kid, err = c.Seal(webhookSecretAAD("space-a"), "v")
	if err != nil {
		t.Fatal(err)
	}
	if v, err := c.Open(kid, webhookSecretAAD("space-b"), n, ct); err == nil {
		t.Fatalf("space a's webhook secret opened for space b: %q", v)
	}
}

func TestResealDoesNotOverwriteASecretChangedMeanwhile(t *testing.T) {
	pool := redirectTestPool(t)
	ctx := context.Background()
	c := mustCipher(t, oldSecretKey, "")
	st := &Store{Pool: pool, Cipher: c}
	in := install(t, st, Grant{Capability: CapabilitySecrets})
	if err := st.PutSecret(ctx, in.ID, "token", "stale"); err != nil {
		t.Fatal(err)
	}
	var spaceID string
	if err := pool.QueryRow(ctx, "insert into spaces (slug, name) values ('cas', 'Cas') returning id::text").Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	hooks := &standup.Webhooks{Pool: pool, Seal: st.SealWebhook, Open: st.OpenWebhook}
	if err := hooks.Put(ctx, spaceID, "", "https://hooks.example/in", "stale"); err != nil {
		t.Fatal(err)
	}
	// Each call rewrites the row about to be re-sealed, in the same unbound
	// form with the same null key_id, as a replica from before key ids would:
	// only the ciphertext tells the reseal its read is stale. One stale row
	// per table, plugin_secrets first.
	calls := 0
	resealHook = func() {
		calls++
		n, ct, _, err := c.sealUnbound("fresh")
		if err != nil {
			t.Fatal(err)
		}
		q := `update plugin_secrets set nonce = $2, ciphertext = $3 where install_id = $1`
		id := in.ID
		if calls == 2 {
			q = `update standup_webhooks set secret_nonce = $2, secret_ciphertext = $3 where space_id = $1`
			id = spaceID
		}
		if _, err := pool.Exec(ctx, q, id, n, ct); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { resealHook = nil })
	resealed, remaining, err := st.ResealSecrets(ctx)
	if err != nil || resealed != 0 || remaining != 2 {
		t.Fatalf("ResealSecrets = (%d, %d, %v), want (0, 2, nil): both writes lost the race", resealed, remaining, err)
	}
	if markerSet(t, pool) {
		t.Fatal("a reseal that found unbound rows at verify set the binding marker")
	}
	if v, err := st.GetSecret(ctx, in.ID, "token"); err != nil || v != "fresh" {
		t.Fatalf("plugin secret after a racing write = (%q, %v), want fresh", v, err)
	}
	var kid string
	var n, ct []byte
	if err := pool.QueryRow(ctx, "select coalesce(key_id, ''), secret_nonce, secret_ciphertext from standup_webhooks where space_id = $1", spaceID).Scan(&kid, &n, &ct); err != nil {
		t.Fatal(err)
	}
	if v, err := st.OpenWebhook(ctx, spaceID, kid, n, ct); err != nil || v != "fresh" {
		t.Fatalf("webhook secret after a racing write = (%q, %v), want fresh", v, err)
	}
}

func TestTheBoundFormBindsTheKeyID(t *testing.T) {
	c := mustCipher(t, oldSecretKey, "")
	aad := pluginSecretAAD("install", "a")
	nonce := make([]byte, 12)
	// Sealed by hand in the documented form: additional data, "|", key id.
	withID := c.cur.aead.Seal(nil, nonce, []byte("v"), append(append([]byte{}, aad...), "|7b0c5e9172d53094"...))
	if v, err := c.Open("7b0c5e9172d53094", aad, nonce, withID); err != nil || v != "v" {
		t.Fatalf("a row sealed with the key id in its additional data = (%q, %v), want v", v, err)
	}
	withoutID := c.cur.aead.Seal(nil, nonce, []byte("v"), aad)
	if v, err := c.Open("7b0c5e9172d53094", aad, nonce, withoutID); err == nil {
		t.Fatalf("a row sealed without the key id in its additional data opened: %q", v)
	}
}

func TestWritesStayUnboundUntilTheResealMarker(t *testing.T) {
	pool := testPool(t)
	clearSecrets(t, pool)
	ctx := context.Background()
	st := &Store{Pool: pool, Cipher: mustCipher(t, oldSecretKey, "")}
	in := install(t, st, Grant{Capability: CapabilitySecrets})
	row := func() (*string, []byte, []byte) {
		var kid *string
		var n, ct []byte
		if err := pool.QueryRow(ctx, "select key_id, nonce, ciphertext from plugin_secrets where install_id = $1", in.ID).Scan(&kid, &n, &ct); err != nil {
			t.Fatal(err)
		}
		return kid, n, ct
	}
	if err := st.PutSecret(ctx, in.ID, "token", "before"); err != nil {
		t.Fatal(err)
	}
	// What a binary from before key ids does: no additional data.
	kid, n, ct := row()
	if p, err := st.Cipher.cur.aead.Open(nil, n, ct, nil); kid != nil || err != nil || string(p) != "before" {
		t.Fatalf("a write before the marker: key_id=%v, old-format open = (%q, %v); want null and before", kid, p, err)
	}
	if _, _, err := st.ResealSecrets(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.PutSecret(ctx, in.ID, "token", "after"); err != nil {
		t.Fatal(err)
	}
	kid, n, ct = row()
	if _, err := st.Cipher.cur.aead.Open(nil, n, ct, nil); kid == nil || *kid != st.Cipher.KeyID() || err == nil {
		t.Fatalf("a write after the marker: key_id=%v, unbound open err=%v; want the current key id and a bound row", kid, err)
	}
}

func TestAMixedRowIsResealedOrCounted(t *testing.T) {
	pool := testPool(t)
	clearSecrets(t, pool)
	ctx := context.Background()
	st := &Store{Pool: pool, Cipher: mustCipher(t, oldSecretKey, "")}
	in := install(t, st, Grant{Capability: CapabilitySecrets})
	// key_id names the current key but the ciphertext is unbound, as when a
	// replica from before key ids rewrites a bound row.
	n, ct, _, err := st.Cipher.sealUnbound("v")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into plugin_secrets (install_id, name, nonce, ciphertext, key_id) values ($1, 'mixed', $2, $3, $4), ($1, 'broken', $2, '\x00', $4)`, in.ID, n, ct, st.Cipher.KeyID()); err != nil {
		t.Fatal(err)
	}
	if v, err := st.GetSecret(ctx, in.ID, "mixed"); err != nil || v != "v" {
		t.Fatalf("mixed row = (%q, %v), want v", v, err)
	}
	resealed, remaining, err := st.ResealSecrets(ctx)
	if err != nil || resealed != 1 || remaining != 1 {
		t.Fatalf("ResealSecrets = (%d, %d, %v), want (1, 1, nil): the openable mixed row re-sealed, the broken one counted", resealed, remaining, err)
	}
	if markerSet(t, pool) {
		t.Fatal("a reseal that left an unopenable row set the binding marker")
	}
}

func markerSet(t *testing.T, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) bool {
	t.Helper()
	var b bool
	if err := pool.QueryRow(context.Background(), "select exists (select 1 from secret_binding)").Scan(&b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAfterTheMarkerAnUnboundRowDoesNotOpen(t *testing.T) {
	pool := testPool(t)
	clearSecrets(t, pool)
	ctx := context.Background()
	st := &Store{Pool: pool, Cipher: mustCipher(t, oldSecretKey, "")}
	in := install(t, st, Grant{Capability: CapabilitySecrets})
	n, ct, _, err := st.Cipher.sealUnbound("planted")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into plugin_secrets (install_id, name, nonce, ciphertext) values ($1, 'token', $2, $3)`, in.ID, n, ct); err != nil {
		t.Fatal(err)
	}
	if v, err := st.GetSecret(ctx, in.ID, "token"); err != nil || v != "planted" {
		t.Fatalf("an unbound row before the marker = (%q, %v), want it to open", v, err)
	}
	bindSecrets(t, pool)
	if v, err := st.GetSecret(ctx, in.ID, "token"); !errors.Is(err, ErrSecretUndecryptable) {
		t.Fatalf("an unbound row after the marker = (%q, %v), want ErrSecretUndecryptable", v, err)
	}
}

func TestAResealThatFailsPartwayLeavesNoMarker(t *testing.T) {
	pool := testPool(t)
	clearSecrets(t, pool)
	st := &Store{Pool: pool, Cipher: mustCipher(t, oldSecretKey, "")}
	in := install(t, st, Grant{Capability: CapabilitySecrets})
	if err := st.PutSecret(context.Background(), in.ID, "token", "v"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	resealHook = cancel
	t.Cleanup(func() { resealHook = nil })
	if _, _, err := st.ResealSecrets(ctx); err == nil {
		t.Fatal("a reseal whose context was cancelled mid-conversion reported success")
	}
	if markerSet(t, pool) {
		t.Fatal("a failed reseal left the binding marker set")
	}
}
