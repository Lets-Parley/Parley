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

// Open reverses Seal. An empty keyID is a row sealed before key ids existed,
// with no additional data; it is tried under both keys.
func (c *Cipher) Open(keyID string, aad, nonce, ciphertext []byte) (string, error) {
	for _, k := range []*sealKey{c.cur, c.prev} {
		if k == nil || (keyID != "" && keyID != k.id) || len(nonce) != k.aead.NonceSize() {
			continue
		}
		var ad []byte
		if keyID != "" {
			ad = withKey(aad, keyID)
		}
		if p, err := k.aead.Open(nil, nonce, ciphertext, ad); err == nil {
			return string(p), nil
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

// SealWebhook and OpenWebhook are Seal and Open for a standup webhook's
// signing secret, bound to its space.
func (c *Cipher) SealWebhook(spaceID, plaintext string) ([]byte, []byte, string, error) {
	return c.Seal(webhookSecretAAD(spaceID), plaintext)
}

func (c *Cipher) OpenWebhook(spaceID, keyID string, nonce, ciphertext []byte) (string, error) {
	return c.Open(keyID, webhookSecretAAD(spaceID), nonce, ciphertext)
}

// PutSecret stores one secret for an install, encrypted.
func (s *Store) PutSecret(ctx context.Context, installID, name, value string) error {
	if s.Cipher == nil {
		return ErrNoSecretKey
	}
	nonce, ciphertext, keyID, err := s.Cipher.Seal(pluginSecretAAD(installID, name), value)
	if err != nil {
		return err
	}
	if _, err := s.Pool.Exec(ctx, `
		insert into plugin_secrets (install_id, name, nonce, ciphertext, key_id)
		values ($1, $2, $3, $4, $5)
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
	v, err := s.Cipher.Open(keyID, pluginSecretAAD(installID, name), nonce, ciphertext)
	if err != nil {
		return "", fmt.Errorf("%q: %w", name, err)
	}
	return v, nil
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// ResealSecrets re-encrypts every plugin secret and standup webhook secret not
// already under the current key. It is a boot step, never a request path. Each
// write is a compare-and-set on the key id and ciphertext it read, so replicas
// booting together cannot overwrite each other or a secret changed meanwhile.
// remaining counts the rows still on another key: ones no configured key opens.
func (s *Store) ResealSecrets(ctx context.Context) (resealed, remaining int, err error) {
	for _, t := range []struct {
		sel, upd string
		aad      func(a, b string) []byte
	}{
		{
			`select install_id::text, name, nonce, ciphertext, coalesce(key_id, '') from plugin_secrets where key_id is distinct from $1`,
			`update plugin_secrets set nonce = $3, ciphertext = $4, key_id = $5
			 where install_id = $1 and name = $2 and coalesce(key_id, '') = $6 and ciphertext = $7`,
			pluginSecretAAD,
		},
		{
			`select space_id::text, '', secret_nonce, secret_ciphertext, coalesce(key_id, '') from standup_webhooks where key_id is distinct from $1`,
			`update standup_webhooks set secret_nonce = $3, secret_ciphertext = $4, key_id = $5
			 where space_id = $1 and $2 = '' and coalesce(key_id, '') = $6 and secret_ciphertext = $7`,
			func(spaceID, _ string) []byte { return webhookSecretAAD(spaceID) },
		},
	} {
		type row struct {
			a, b          string
			nonce, sealed []byte
			keyID         string
		}
		rows, err := s.Pool.Query(ctx, t.sel, s.Cipher.KeyID())
		if err != nil {
			return resealed, remaining, fmt.Errorf("listing secrets to re-seal: %w", err)
		}
		found, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
			var x row
			return x, r.Scan(&x.a, &x.b, &x.nonce, &x.sealed, &x.keyID)
		})
		if err != nil {
			return resealed, remaining, fmt.Errorf("listing secrets to re-seal: %w", err)
		}
		for _, x := range found {
			plain, err := s.Cipher.Open(x.keyID, t.aad(x.a, x.b), x.nonce, x.sealed)
			if err != nil {
				remaining++
				continue
			}
			nonce, sealed, keyID, err := s.Cipher.Seal(t.aad(x.a, x.b), plain)
			if err != nil {
				return resealed, remaining, err
			}
			tag, err := s.Pool.Exec(ctx, t.upd, x.a, x.b, nonce, sealed, keyID, x.keyID, x.sealed)
			if err != nil {
				return resealed, remaining, fmt.Errorf("re-sealing a secret: %w", err)
			}
			resealed += int(tag.RowsAffected())
		}
	}
	return resealed, remaining, nil
}
