package plugin

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Cipher encrypts plugin secrets at rest with AES-GCM.
type Cipher struct{ aead cipher.AEAD }

// NewCipher builds a cipher from a base64-encoded 32-byte key. A key of any
// other length is refused rather than stretched: a short key that silently
// works is the failure mode this exists to prevent.
func NewCipher(base64Key string) (*Cipher, error) {
	key, err := base64.StdEncoding.DecodeString(base64Key)
	if err != nil {
		return nil, fmt.Errorf("decoding the plugin secret key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("the plugin secret key decodes to %d bytes; it must be exactly 32 (generate one with: openssl rand -base64 32)", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("building the plugin secret cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("building the plugin secret cipher: %w", err)
	}
	return &Cipher{aead: aead}, nil
}

func (c *Cipher) seal(plaintext string) (nonce, ciphertext []byte, err error) {
	nonce = make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, fmt.Errorf("generating a nonce: %w", err)
	}
	return nonce, c.aead.Seal(nil, nonce, []byte(plaintext), nil), nil
}

func (c *Cipher) open(nonce, ciphertext []byte) (string, error) {
	plaintext, err := c.aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypting the plugin secret: %w", err)
	}
	return string(plaintext), nil
}

// PutSecret stores one secret for an install, encrypted.
func (s *Store) PutSecret(ctx context.Context, installID, name, value string) error {
	if s.Cipher == nil {
		return ErrNoSecretKey
	}
	nonce, ciphertext, err := s.Cipher.seal(value)
	if err != nil {
		return err
	}
	if _, err := s.Pool.Exec(ctx, `
		insert into plugin_secrets (install_id, name, nonce, ciphertext)
		values ($1, $2, $3, $4)
		on conflict (install_id, name) do update
			set nonce = excluded.nonce, ciphertext = excluded.ciphertext, updated_at = now()`,
		installID, name, nonce, ciphertext); err != nil {
		return fmt.Errorf("storing plugin secret %q: %w", name, err)
	}
	return nil
}

// GetSecret reads one secret back.
func (s *Store) GetSecret(ctx context.Context, installID, name string) (string, error) {
	if s.Cipher == nil {
		return "", ErrNoSecretKey
	}
	var nonce, ciphertext []byte
	if err := s.Pool.QueryRow(ctx,
		`select nonce, ciphertext from plugin_secrets where install_id = $1 and name = $2`,
		installID, name).Scan(&nonce, &ciphertext); err != nil {
		return "", fmt.Errorf("reading plugin secret %q: %w", name, err)
	}
	return s.Cipher.open(nonce, ciphertext)
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
