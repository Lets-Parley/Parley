// Package auth wraps an OpenID Connect provider as a relying party.
//
// There is deliberately no per-vendor code here. Every provider worth
// supporting — Keycloak, Authentik, Zitadel, Auth0, Okta, Entra, Google —
// publishes a discovery document, so swapping identity providers is a change of
// configuration rather than a change of code.
package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
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
}

func New(cfg Config) *Provider { return &Provider{cfg: cfg} }

func (p *Provider) Issuer() string { return p.cfg.Issuer }

// discover resolves the provider's endpoints, caching them after the first
// success. Callers hit this on every request; it is cheap once warm.
func (p *Provider) discover(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.oauth != nil {
		return nil
	}
	prov, err := oidc.NewProvider(ctx, p.cfg.Issuer)
	if err != nil {
		return fmt.Errorf("could not reach the identity provider at %s: %w", p.cfg.Issuer, err)
	}
	scopes := append([]string{oidc.ScopeOpenID}, p.cfg.Scopes...)
	p.oauth = &oauth2.Config{
		ClientID:     p.cfg.ClientID,
		ClientSecret: p.cfg.ClientSecret,
		RedirectURL:  p.cfg.RedirectURL,
		Endpoint:     prov.Endpoint(),
		Scopes:       scopes,
	}
	p.verifier = prov.Verifier(&oidc.Config{ClientID: p.cfg.ClientID})
	return nil
}

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
	if idToken.Nonce != nonce {
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
		if len(c) > 64 {
			c = strings.TrimSpace(c[:64])
		}
		if c != "" {
			return c
		}
	}
	return "Someone"
}
