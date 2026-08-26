// Package auth wraps an OpenID Connect provider as a relying party.
//
// There is deliberately no per-vendor code here. Every provider worth
// supporting — Keycloak, Authentik, Zitadel, Auth0, Okta, Entra, Google —
// publishes a discovery document, so swapping identity providers is a change of
// configuration rather than a change of code.
package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"golang.org/x/sync/singleflight"
)

type Config struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	// Scopes beyond "openid", which is always requested.
	Scopes []string
}

// Identity is what a completed sign-in tells us about a person. It is
// deliberately narrow: Parley stores a name and nothing else.
type Identity struct {
	Issuer  string
	Subject string
	Name    string
}

type Provider struct {
	cfg Config

	// Discovery is deferred rather than done at boot. An identity provider that
	// is briefly unreachable should fail sign-ins, not stop the whole server
	// from starting — a standup already in progress does not care that Keycloak
	// is restarting.
	mu       sync.Mutex
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier

	// Concurrent sign-ins collapse onto a single discovery attempt, so a
	// provider that hangs costs one timeout in total rather than one each.
	flight singleflight.Group
	// Overridden only by tests, which cannot wait 15s to watch a hang.
	discoveryTimeout time.Duration
}

func New(cfg Config) *Provider { return &Provider{cfg: cfg} }

func (p *Provider) Issuer() string { return p.cfg.Issuer }

// discoveryWindow is how long a discovery attempt may run. Tests shorten it;
// production leaves it unset and gets 15s.
func (p *Provider) discoveryWindow() time.Duration {
	if p.discoveryTimeout == 0 {
		return 15 * time.Second
	}
	return p.discoveryTimeout
}

// discover resolves the provider's endpoints, caching them after the first
// success. Callers hit this on every request; it is cheap once warm.
func (p *Provider) discover(ctx context.Context) error {
	p.mu.Lock()
	warm := p.oauth != nil
	p.mu.Unlock()
	if warm {
		return nil
	}
	timeout := p.discoveryWindow()
	_, err, _ := p.flight.Do("discover", func() (any, error) {
		// Detached from the caller: whoever happens to win the race must not be
		// able to fail everyone else's sign-in by closing their browser tab.
		// http.DefaultClient has no timeout of its own, so the bound is ours.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
		defer cancel()
		prov, err := oidc.NewProvider(ctx, p.cfg.Issuer)
		if err != nil {
			return nil, fmt.Errorf("could not reach the identity provider at %s: %w", p.cfg.Issuer, err)
		}
		scopes := append([]string{oidc.ScopeOpenID}, p.cfg.Scopes...)
		p.mu.Lock()
		defer p.mu.Unlock()
		p.oauth = &oauth2.Config{
			ClientID:     p.cfg.ClientID,
			ClientSecret: p.cfg.ClientSecret,
			RedirectURL:  p.cfg.RedirectURL,
			Endpoint:     prov.Endpoint(),
			Scopes:       scopes,
		}
		p.verifier = prov.Verifier(&oidc.Config{ClientID: p.cfg.ClientID})
		return nil, nil
	})
	return err
}

// Warm resolves the provider's endpoints ahead of the first sign-in, so a boot
// probe can report whether the issuer is reachable. It is the same discovery
// the sign-in path runs, sharing the same singleflight and the same cache, so
// a successful probe also saves the first person to sign in a round trip.
//
// A failure is not cached: discover only populates the cache on success, and
// singleflight.Do memoizes nothing across calls. A probe against a provider
// that is merely slow to start therefore costs a warning line and nothing
// else — later sign-ins retry discovery from scratch.
//
// Success means the issuer answered its discovery document. It says nothing
// about whether the client ID and secret are right; those are only tested at
// token exchange.
func (p *Provider) Warm(ctx context.Context) error { return p.discover(ctx) }

// AuthCodeURL builds the redirect that starts a sign-in. The caller keeps state,
// nonce and the PKCE verifier and must present them again at the callback.
func (p *Provider) AuthCodeURL(ctx context.Context, state, nonce, pkceVerifier string) (string, error) {
	if err := p.discover(ctx); err != nil {
		return "", err
	}
	return p.oauth.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(pkceVerifier),
	), nil
}

var ErrNonceMismatch = errors.New("the sign-in reply did not match the request that started it")

// Exchange trades the authorization code for an identity, verifying the ID
// token's signature, audience, expiry, and nonce before believing any of it.
func (p *Provider) Exchange(ctx context.Context, code, pkceVerifier, nonce string) (Identity, error) {
	if err := p.discover(ctx); err != nil {
		return Identity{}, err
	}
	tok, err := p.oauth.Exchange(ctx, code, oauth2.VerifierOption(pkceVerifier))
	if err != nil {
		return Identity{}, fmt.Errorf("the identity provider refused the authorization code: %w", err)
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok {
		return Identity{}, errors.New("the identity provider returned no id_token — check that the openid scope is allowed for this client")
	}
	idToken, err := p.verifier.Verify(ctx, rawID)
	if err != nil {
		return Identity{}, fmt.Errorf("could not verify the id_token: %w", err)
	}
	// The nonce ties this token to the browser that started the sign-in, which
	// is what stops a token obtained elsewhere from being replayed here.
	if subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(nonce)) != 1 {
		return Identity{}, ErrNonceMismatch
	}

	var claims struct {
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
		Email             string `json:"email"`
	}
	// Claims are best-effort: a provider that sends only "sub" still yields a
	// usable account, just with a duller name.
	_ = idToken.Claims(&claims)

	return Identity{
		Issuer:  idToken.Issuer,
		Subject: idToken.Subject,
		Name:    displayName(claims.Name, claims.PreferredUsername, claims.Email, idToken.Subject),
	}, nil
}

// displayName picks the friendliest claim the provider actually sent. The users
// table caps names at 64 characters, so the result is always trimmed to fit.
func displayName(candidates ...string) string {
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		// An email is a poor name but a fine fallback; the local part reads
		// better on a roster than the whole address.
		if at := strings.IndexByte(c, '@'); at > 0 && strings.Contains(c, ".") {
			c = c[:at]
		}
		// The column's check is char_length, so the cap counts runes; slicing
		// bytes would cut a multi-byte name mid-rune and hand Postgres invalid
		// UTF-8, which it rejects outright.
		if r := []rune(c); len(r) > 64 {
			c = strings.TrimSpace(string(r[:64]))
		}
		if c != "" {
			return c
		}
	}
	return "Someone"
}
