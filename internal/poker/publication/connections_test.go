package publication

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/lets-parley/parley/internal/plugin"
)

func TestConnectionScopeRevocationAndReplacement(t *testing.T) {
	e, s, _, _ := fixture(t)
	cipher, err := plugin.NewCipher(base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901")))
	if err != nil {
		t.Fatal(err)
	}
	store := &Connections{Pool: e.Pool, Secrets: &plugin.Store{Pool: e.Pool, Cipher: cipher}}
	config := ConnectionConfig{Owner: "test", Repository: "repo", ParentID: "1", ProjectID: "P", FieldID: "F", ReadConsent: true}
	// Save receives configuration validated by the host verifier, never a browser capability.
	if err = store.save(context.Background(), s, config, "private-token"); err != nil {
		t.Fatal(err)
	}
	got, err := store.Resolve(context.Background(), s)
	if err != nil || got.Token != "private-token" || got.WriteConsent {
		t.Fatalf("read binding: %#v %v", got.Capability, err)
	}
	foreign := s
	foreign.PrincipalID = "00000000-0000-0000-0000-000000000001"
	if _, err = store.Resolve(context.Background(), foreign); !errors.Is(err, ErrPaused) {
		t.Fatal("foreign principal read connection")
	}
	first := got.Capability.Generation
	config.WriteConsent = true
	if err = store.save(context.Background(), s, config, "replacement"); err != nil {
		t.Fatal(err)
	}
	got, err = store.Resolve(context.Background(), s)
	if err != nil || got.Token != "replacement" || !got.WriteConsent || got.Capability.Generation == first {
		t.Fatal("replacement did not invalidate generation")
	}
	if err = store.Revoke(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Resolve(context.Background(), s); !errors.Is(err, ErrPaused) {
		t.Fatal("revoked connection read")
	}
}

func TestConnectionRefusesUnreviewedAndInvalidConfiguration(t *testing.T) {
	e, s, _, _ := fixture(t)
	cipher, _ := plugin.NewCipher(base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901")))
	c := &Connections{Pool: e.Pool, Secrets: &plugin.Store{Pool: e.Pool, Cipher: cipher}}
	for _, config := range []ConnectionConfig{{Owner: "test", Repository: "repo", ParentID: "1", ProjectID: "P", FieldID: "F"}, {Owner: "../bad", ReadConsent: true}, {Owner: "test", Repository: "repo", ParentID: "1", ProjectID: "P", FieldID: "F", ReadConsent: true}} {
		if err := c.Connect(context.Background(), s, config, ""); !errors.Is(err, ErrPaused) {
			t.Fatal("invalid connection accepted")
		}
	}
	var count int
	if err := e.Pool.QueryRow(context.Background(), "select count(*) from poker_publication_connections where session_id=$1", s.SessionID).Scan(&count); err != nil || count != 0 {
		t.Fatal("refusal stored credential")
	}
}

func TestReceiptsRemainBoundToApprovingPrincipal(t *testing.T) {
	e, s, r, _ := fixture(t)
	review := approve(t, e, s, r)
	var other string
	if err := e.Pool.QueryRow(context.Background(), `insert into users(name) values('replacement facilitator') returning id::text`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`insert into members(space_id,user_id,role) values($1,$2,'member')`, []any{s.SpaceID, other}},
		{`insert into org_members(org_id,user_id,role) values($1,$2,'member')`, []any{s.OrgID, other}},
		{`update sessions set facilitator_id=$1 where id=$2`, []any{other, s.SessionID}},
	} {
		if _, err := e.Pool.Exec(context.Background(), statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	s.PrincipalID = other
	if _, err := e.Receipts(context.Background(), s, review.ID); !errors.Is(err, ErrPaused) {
		t.Fatalf("replacement facilitator accessed prior principal receipt: %v", err)
	}
}

func TestConnectionRotationResealAndWrongScope(t *testing.T) {
	e, s, _, _ := fixture(t)
	oldKey := base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901"))
	newKey := base64.StdEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	if _, err := e.Pool.Exec(context.Background(), "delete from plugin_secrets; delete from standup_webhooks; delete from poker_publication_connections; delete from secret_binding"); err != nil {
		t.Fatal(err)
	}
	old, _ := plugin.NewCipher(oldKey)
	secrets := &plugin.Store{Pool: e.Pool, Cipher: old}
	c := &Connections{Pool: e.Pool, Secrets: secrets}
	config := ConnectionConfig{Owner: "test", Repository: "repo", ParentID: "1", ProjectID: "P", FieldID: "F", ReadConsent: true}
	if err := c.save(context.Background(), s, config, "rotation-secret"); err != nil {
		t.Fatal(err)
	}
	rotated, _ := plugin.NewRotatingCipher(newKey, oldKey)
	secrets.Cipher = rotated
	if got, err := c.Resolve(context.Background(), s); err != nil || got.Token != "rotation-secret" {
		t.Fatal("previous key did not read bound connection")
	}
	stale, err := secrets.StaleSecrets(context.Background())
	if err != nil || stale != 1 {
		t.Fatalf("rotation omitted connection: %d %v", stale, err)
	}
	count, remaining, err := secrets.ResealSecrets(context.Background())
	if err != nil || count != 1 || remaining != 0 {
		t.Fatalf("reseal connection: %d %d %v", count, remaining, err)
	}
	current, _ := plugin.NewCipher(newKey)
	secrets.Cipher = current
	if got, err := c.Resolve(context.Background(), s); err != nil || got.Token != "rotation-secret" {
		t.Fatal("connection not recovered under current key")
	}
	if _, err := e.Pool.Exec(context.Background(), `update poker_publication_connections set ciphertext='\x0001'::bytea where session_id=$1`, s.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resolve(context.Background(), s); !errors.Is(err, ErrPaused) {
		t.Fatal("corrupt credential opened")
	}
	_, remaining, err = secrets.ResealSecrets(context.Background())
	if err != nil || remaining != 1 {
		t.Fatalf("corrupt credential absent from recovery refusal: %d %v", remaining, err)
	}
	keyBytes, _ := base64.StdEncoding.DecodeString(newKey)
	block, _ := aes.NewCipher(keyBytes)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	legacy := gcm.Seal(nil, nonce, []byte("legacy cannot authorize publication"), nil)
	if _, err := e.Pool.Exec(context.Background(), `update poker_publication_connections set nonce=$2,ciphertext=$3 where session_id=$1`, s.SessionID, nonce, legacy); err != nil {
		t.Fatal(err)
	}
	_, remaining, err = secrets.ResealSecrets(context.Background())
	if err != nil || remaining != 1 {
		t.Fatalf("recovery accepted unbound publication ciphertext: %d %v", remaining, err)
	}
	if _, err := c.Resolve(context.Background(), s); !errors.Is(err, ErrPaused) {
		t.Fatal("unbound credential opened after reseal")
	}
	if err := c.Revoke(context.Background(), s); err != nil {
		t.Fatal(err)
	}
}

func TestPreviewDistinguishesReusedIssueFromNewCreation(t *testing.T) {
	e, s, r, _ := fixture(t)
	v := approve(t, e, s, r)
	if err := e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(context.Background(), `update stories set title='Changed local title',content_revision=content_revision+1 where id=$1`, r.Children[0]); err != nil {
		t.Fatal(err)
	}
	preview, err := e.Preview(context.Background(), s, r)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, receipt := range preview.Existing {
		if receipt.Kind == "create" && receipt.ChildID == r.Children[0] {
			found = true
			if receipt.State != Confirmed || receipt.RemoteID == "" {
				t.Fatal("preview did not distinguish issued identity")
			}
		}
	}
	if !found {
		t.Fatal("preview omits existing create identity")
	}
}

func TestConnectionRechecksRoleRevocationAndReadConsent(t *testing.T) {
	e, s, _, _ := fixture(t)
	cipher, _ := plugin.NewCipher(base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901")))
	c := &Connections{Pool: e.Pool, Secrets: &plugin.Store{Pool: e.Pool, Cipher: cipher}}
	config := ConnectionConfig{Owner: "test", Repository: "repo", ParentID: "1", ProjectID: "P", FieldID: "F", ReadConsent: true}
	if err := c.save(context.Background(), s, config, "private-token"); err != nil {
		t.Fatal(err)
	}
	_, other, _, _ := fixture(t)
	if _, err := e.Pool.Exec(context.Background(), `update sessions set facilitator_id=$2 where id=$1`, s.SessionID, other.PrincipalID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resolve(context.Background(), s); !errors.Is(err, ErrPaused) {
		t.Fatal("former facilitator retained PAT access")
	}
	if _, err := e.Pool.Exec(context.Background(), `update sessions set facilitator_id=$2 where id=$1`, s.SessionID, s.PrincipalID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(context.Background(), `update org_members set revoked_at=now() where org_id=$1 and user_id=$2`, s.OrgID, s.PrincipalID); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resolve(context.Background(), s); !errors.Is(err, ErrPaused) {
		t.Fatal("revoked org member retained PAT access")
	}
	if _, err := e.Pool.Exec(context.Background(), `update org_members set revoked_at=null where org_id=$1 and user_id=$2`, s.OrgID, s.PrincipalID); err != nil {
		t.Fatal(err)
	}
	config.ReadConsent = false
	if err := c.save(context.Background(), s, config, "private-token"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resolve(context.Background(), s); !errors.Is(err, ErrPaused) {
		t.Fatal("missing read consent retained PAT access")
	}
	if err := c.Revoke(context.Background(), s); err != nil {
		t.Fatal(err)
	}
}
