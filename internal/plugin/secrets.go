package plugin

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrSecretNotSet means no secret by that name is stored. ErrSecretUndecryptable
// means one is stored but no configured key opens it — a rotated key with no
// PLUGIN_SECRET_KEY_PREVIOUS, or a row moved from where it was sealed. They are
// different problems for an operator, so they are different errors.
var (
	ErrSecretNotSet        = errors.New("plugin secret is not set")
	ErrSecretUndecryptable = errors.New("plugin secret cannot be decrypted with the configured keys")
)

type sealKey struct {
	id   string
	aead cipher.AEAD
}

// Cipher encrypts secrets at rest with AES-GCM. Every seal binds additional
// data naming where the row lives and which key sealed it, so a row copied to
// another install, name or table does not open. A previous key, when set, is
// used only to open.
type Cipher struct{ cur, prev *sealKey }

func newSealKey(base64Key string) (*sealKey, error) {
	key, err := base64.StdEncoding.DecodeString(base64Key)
	if err != nil {
		return nil, fmt.Errorf("decoding the key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("the key decodes to %d bytes; it must be exactly 32 (generate one with: openssl rand -base64 32)", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("building the secret cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("building the secret cipher: %w", err)
	}
	// The key id is a fingerprint, never the key: HMAC keyed by the key over a
	// fixed label, truncated to 8 bytes.
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("parley-secret-key-id-v1"))
	return &sealKey{id: hex.EncodeToString(mac.Sum(nil)[:8]), aead: aead}, nil
}

// NewCipher builds a cipher from a base64-encoded 32-byte key. A key of any
// other length is refused rather than stretched: a short key that silently
// works is the failure mode this exists to prevent.
func NewCipher(base64Key string) (*Cipher, error) { return NewRotatingCipher(base64Key, "") }

// NewRotatingCipher is NewCipher plus an optional previous key that is only
// ever used to open. A previous key equal to the current one is refused: it
// would mean the rotation the operator believes happened did not.
func NewRotatingCipher(current, previous string) (*Cipher, error) {
	cur, err := newSealKey(current)
	if err != nil {
		return nil, err
	}
	c := &Cipher{cur: cur}
	if previous != "" {
		if c.prev, err = newSealKey(previous); err != nil {
			return nil, fmt.Errorf("the previous key: %w", err)
		}
		if c.prev.id == cur.id {
			return nil, errors.New("the previous key is the same as the current key")
		}
	}
	return c, nil
}

// KeyID is the fingerprint of the current key, as stored beside each row.
func (c *Cipher) KeyID() string { return c.cur.id }

func withKey(aad []byte, keyID string) []byte {
	return append(append(bytes.Clone(aad), '|'), keyID...)
}

// Seal encrypts plaintext under the current key, bound to aad.
func (c *Cipher) Seal(aad []byte, plaintext string) (nonce, ciphertext []byte, keyID string, err error) {
	nonce = make([]byte, c.cur.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, "", fmt.Errorf("generating a nonce: %w", err)
	}
	return nonce, c.cur.aead.Seal(nil, nonce, []byte(plaintext), withKey(aad, c.cur.id)), c.cur.id, nil
}

// sealUnbound encrypts with no additional data and no key id: the form the
// binaries from before key ids can open.
func (c *Cipher) sealUnbound(plaintext string) (nonce, ciphertext []byte, keyID string, err error) {
	nonce = make([]byte, c.cur.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, "", fmt.Errorf("generating a nonce: %w", err)
	}
	return nonce, c.cur.aead.Seal(nil, nonce, []byte(plaintext), nil), "", nil
}

// openBound opens only a row sealed bound to aad under the current key: the
// form every row has once a reseal has finished.
func (c *Cipher) openBound(keyID string, aad, nonce, ciphertext []byte) bool {
	if keyID != c.cur.id || len(nonce) != c.cur.aead.NonceSize() {
		return false
	}
	_, err := c.cur.aead.Open(nil, nonce, ciphertext, withKey(aad, keyID))
	return err == nil
}

// Open reverses Seal and sealUnbound. The key id picks which bound form to try,
// but never rules out the unbound one: a replica from before key ids can
// rewrite a row's ciphertext and leave its key_id standing. Once the binding
// marker exists, readers go through Store and accept the bound form only.
func (c *Cipher) Open(keyID string, aad, nonce, ciphertext []byte) (string, error) {
	return c.openAs(keyID, aad, nonce, ciphertext, true)
}

func (c *Cipher) openAs(keyID string, aad, nonce, ciphertext []byte, allowUnbound bool) (string, error) {
	forms := []bool{true}
	if allowUnbound {
		forms = append(forms, false)
	}
	for _, bound := range forms {
		for _, k := range []*sealKey{c.cur, c.prev} {
			if k == nil || (bound && keyID != k.id) || len(nonce) != k.aead.NonceSize() {
				continue
			}
			var ad []byte
			if bound {
				ad = withKey(aad, keyID)
			}
			if p, err := k.aead.Open(nil, nonce, ciphertext, ad); err == nil {
				return string(p), nil
			}
		}
	}
	return "", ErrSecretUndecryptable
}

func pluginSecretAAD(installID, name string) []byte {
	return []byte("plugin-secret|" + installID + "|" + name)
}

func webhookSecretAAD(spaceID string) []byte {
	return []byte("standup-webhook|" + spaceID)
}

// bound reports whether "parley secrets reseal" has recorded that every
// replica reads the bound form. It is read on every write, so the switch
// reaches every replica at once.
func (s *Store) bound(ctx context.Context) (bool, error) {
	var b bool
	if err := s.Pool.QueryRow(ctx, "select exists (select 1 from secret_binding)").Scan(&b); err != nil {
		return false, fmt.Errorf("reading the secret binding marker: %w", err)
	}
	return b, nil
}

// seal writes the bound form once the marker exists, the unbound one before.
func (s *Store) seal(ctx context.Context, aad []byte, plaintext string) ([]byte, []byte, string, error) {
	b, err := s.bound(ctx)
	if err != nil {
		return nil, nil, "", err
	}
	if b {
		return s.Cipher.Seal(aad, plaintext)
	}
	return s.Cipher.sealUnbound(plaintext)
}

// SealWebhook seals a standup webhook's signing secret for its space.
func (s *Store) SealWebhook(ctx context.Context, spaceID, plaintext string) ([]byte, []byte, string, error) {
	return s.seal(ctx, webhookSecretAAD(spaceID), plaintext)
}

// open accepts both forms before the binding marker and the bound form only
// after it, so a row written unbound behind the reseal's back never opens.
func (s *Store) open(ctx context.Context, keyID string, aad, nonce, ciphertext []byte) (string, error) {
	b, err := s.bound(ctx)
	if err != nil {
		return "", err
	}
	return s.Cipher.openAs(keyID, aad, nonce, ciphertext, !b)
}

// OpenWebhook opens a standup webhook's signing secret.
func (s *Store) OpenWebhook(ctx context.Context, spaceID, keyID string, nonce, ciphertext []byte) (string, error) {
	return s.open(ctx, keyID, webhookSecretAAD(spaceID), nonce, ciphertext)
}

// PutSecret stores one secret for an install, encrypted.
func (s *Store) PutSecret(ctx context.Context, installID, name, value string) error {
	if s.Cipher == nil {
		return ErrNoSecretKey
	}
	nonce, ciphertext, keyID, err := s.seal(ctx, pluginSecretAAD(installID, name), value)
	if err != nil {
		return err
	}
	if _, err := s.Pool.Exec(ctx, `
		insert into plugin_secrets (install_id, name, nonce, ciphertext, key_id)
		values ($1, $2, $3, $4, nullif($5, ''))
		on conflict (install_id, name) do update
			set nonce = excluded.nonce, ciphertext = excluded.ciphertext,
			    key_id = excluded.key_id, updated_at = now()`,
		installID, name, nonce, ciphertext, keyID); err != nil {
		return fmt.Errorf("storing plugin secret %q: %w", name, err)
	}
	return nil
}

// GetSecret reads one secret back: ErrSecretNotSet when there is none,
// ErrSecretUndecryptable when there is one no configured key opens.
func (s *Store) GetSecret(ctx context.Context, installID, name string) (string, error) {
	if s.Cipher == nil {
		return "", ErrNoSecretKey
	}
	var nonce, ciphertext []byte
	var keyID string
	err := s.Pool.QueryRow(ctx,
		`select nonce, ciphertext, coalesce(key_id, '') from plugin_secrets where install_id = $1 and name = $2`,
		installID, name).Scan(&nonce, &ciphertext, &keyID)
	if isNoRows(err) {
		return "", fmt.Errorf("%q: %w", name, ErrSecretNotSet)
	}
	if err != nil {
		return "", fmt.Errorf("reading plugin secret %q: %w", name, err)
	}
	v, err := s.open(ctx, keyID, pluginSecretAAD(installID, name), nonce, ciphertext)
	if err != nil {
		return "", fmt.Errorf("%q: %w", name, err)
	}
	return v, nil
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// StaleSecrets counts the secrets not recorded under the current key. It is
// a cheap boot-time hint; ResealSecrets is what checks every row.
func (s *Store) StaleSecrets(ctx context.Context) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `
		select (select count(*) from plugin_secrets where key_id is distinct from $1)
		     + (select count(*) from standup_webhooks where key_id is distinct from $1)`,
		s.Cipher.KeyID()).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("counting secrets not under the current key: %w", err)
	}
	return n, nil
}

// resealHook runs between a row's read and its write; tests use it to race a
// concurrent change against the compare-and-set.
var resealHook func()

type sealedTable struct {
	sel, upd string
	aad      func(a, b string) []byte
}

var sealedTables = []sealedTable{
	{
		`select install_id::text, name, nonce, ciphertext, coalesce(key_id, '') from plugin_secrets`,
		`update plugin_secrets set nonce = $3, ciphertext = $4, key_id = $5
		 where install_id = $1 and name = $2 and ciphertext = $6`,
		pluginSecretAAD,
	},
	{
		`select space_id::text, '', secret_nonce, secret_ciphertext, coalesce(key_id, '') from standup_webhooks`,
		`update standup_webhooks set secret_nonce = $3, secret_ciphertext = $4, key_id = $5
		 where space_id = $1 and $2 = '' and secret_ciphertext = $6`,
		func(spaceID, _ string) []byte { return webhookSecretAAD(spaceID) },
	},
}

type sealedRow struct {
	a, b          string
	nonce, sealed []byte
	keyID         string
}

func sealedRows(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, t sealedTable) ([]sealedRow, error) {
	rows, err := q.Query(ctx, t.sel)
	if err != nil {
		return nil, fmt.Errorf("listing sealed secrets: %w", err)
	}
	found, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (sealedRow, error) {
		var x sealedRow
		return x, r.Scan(&x.a, &x.b, &x.nonce, &x.sealed, &x.keyID)
	})
	if err != nil {
		return nil, fmt.Errorf("listing sealed secrets: %w", err)
	}
	return found, nil
}

// ResealSecrets is "parley secrets reseal", run once every replica reads the
// bound form. It re-seals every row that does not open bound under the current
// key, each write a compare-and-set on the ciphertext it read. Then, in one
// transaction holding both tables against writes, it checks every row and
// records the binding marker only if none remains: a failed or incomplete run
// leaves no marker, and a write racing the check waits for it. remaining is
// what that check counted; on error it is unknown and -1.
func (s *Store) ResealSecrets(ctx context.Context) (resealed, remaining int, err error) {
	for _, t := range sealedTables {
		found, err := sealedRows(ctx, s.Pool, t)
		if err != nil {
			return resealed, -1, err
		}
		for _, x := range found {
			aad := t.aad(x.a, x.b)
			if s.Cipher.openBound(x.keyID, aad, x.nonce, x.sealed) {
				continue
			}
			plain, err := s.Cipher.Open(x.keyID, aad, x.nonce, x.sealed)
			if err != nil {
				continue // counted below
			}
			nonce, sealed, keyID, err := s.Cipher.Seal(aad, plain)
			if err != nil {
				return resealed, -1, err
			}
			if resealHook != nil {
				resealHook()
			}
			tag, err := s.Pool.Exec(ctx, t.upd, x.a, x.b, nonce, sealed, keyID, x.sealed)
			if err != nil {
				return resealed, -1, fmt.Errorf("re-sealing a secret: %w", err)
			}
			resealed += int(tag.RowsAffected())
		}
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return resealed, -1, fmt.Errorf("starting the reseal check: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "lock table plugin_secrets, standup_webhooks in share row exclusive mode"); err != nil {
		return resealed, -1, fmt.Errorf("locking the secret tables: %w", err)
	}
	for _, t := range sealedTables {
		found, err := sealedRows(ctx, tx, t)
		if err != nil {
			return resealed, -1, err
		}
		for _, x := range found {
			if !s.Cipher.openBound(x.keyID, t.aad(x.a, x.b), x.nonce, x.sealed) {
				remaining++
			}
		}
	}
	if remaining > 0 {
		return resealed, remaining, nil
	}
	if _, err := tx.Exec(ctx, "insert into secret_binding default values on conflict do nothing"); err != nil {
		return resealed, -1, fmt.Errorf("recording the secret binding marker: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return resealed, -1, fmt.Errorf("recording the secret binding marker: %w", err)
	}
	return resealed, 0, nil
}
