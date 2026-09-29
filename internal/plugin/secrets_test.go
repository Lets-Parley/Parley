package plugin

import (
	"context"
	"errors"
	"testing"

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
	if _, err := pool.Exec(context.Background(), "delete from plugin_secrets; delete from standup_webhooks"); err != nil {
		t.Fatal(err)
	}
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

	nonce, sealed, keyID, err := s.Cipher.SealWebhook(a.ID, "webhook-secret")
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
		return &standup.Webhooks{
			Pool: pool, BaseURL: "https://parley.example", Seal: c.SealWebhook, Open: c.OpenWebhook,
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
	n, ct, kid, err = c.SealWebhook("space-a", "v")
	if err != nil {
		t.Fatal(err)
	}
	if v, err := c.OpenWebhook("space-b", kid, n, ct); err == nil {
		t.Fatalf("space a's webhook secret opened for space b: %q", v)
	}
}

func TestResealDoesNotOverwriteASecretChangedMeanwhile(t *testing.T) {
	pool := redirectTestPool(t)
	ctx := context.Background()
	oldC, newC := mustCipher(t, oldSecretKey, ""), mustCipher(t, newSecretKey, oldSecretKey)
	old := &Store{Pool: pool, Cipher: oldC}
	in := install(t, old, Grant{Capability: CapabilitySecrets})
	if err := old.PutSecret(ctx, in.ID, "token", "stale"); err != nil {
		t.Fatal(err)
	}
	var spaceID string
	if err := pool.QueryRow(ctx, "insert into spaces (slug, name) values ('cas', 'Cas') returning id::text").Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	hooks := func(c *Cipher) *standup.Webhooks {
		return &standup.Webhooks{Pool: pool, Seal: c.SealWebhook, Open: c.OpenWebhook}
	}
	if err := hooks(oldC).Put(ctx, spaceID, "", "https://hooks.example/in", "stale"); err != nil {
		t.Fatal(err)
	}
	rotated := &Store{Pool: pool, Cipher: newC}
	// One stale row per table, plugin_secrets first: each call races the
	// write for the row about to be re-sealed.
	calls := 0
	resealHook = func() {
		calls++
		var err error
		if calls == 1 {
			err = rotated.PutSecret(ctx, in.ID, "token", "fresh")
		} else {
			err = hooks(newC).Put(ctx, spaceID, "", "https://hooks.example/in", "fresh")
		}
		if err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { resealHook = nil })
	if _, _, err := rotated.ResealSecrets(ctx); err != nil {
		t.Fatal(err)
	}
	if v, err := rotated.GetSecret(ctx, in.ID, "token"); err != nil || v != "fresh" {
		t.Fatalf("plugin secret after a racing write = (%q, %v), want fresh", v, err)
	}
	var kid string
	var n, ct []byte
	if err := pool.QueryRow(ctx, "select key_id, secret_nonce, secret_ciphertext from standup_webhooks where space_id = $1", spaceID).Scan(&kid, &n, &ct); err != nil {
		t.Fatal(err)
	}
	if v, err := newC.OpenWebhook(spaceID, kid, n, ct); err != nil || v != "fresh" {
		t.Fatalf("webhook secret after a racing write = (%q, %v), want fresh", v, err)
	}
}
