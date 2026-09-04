package main

import (
	"net/http"
	"testing"
	"time"
)

func TestVersionDefaultsToDev(t *testing.T) {
	if version != "dev" {
		t.Fatalf("version = %q, want dev", version)
	}
}

func baseConfigEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://example.test/parley?sslmode=verify-full")
	t.Setenv("DATABASE_ALLOW_PLAINTEXT", "")
	t.Setenv("PGSSLMODE", "")
	t.Setenv("PGSSLROOTCERT", "")
	t.Setenv("TRUST_PROXY_HEADERS", "false")
	t.Setenv("TRUSTED_PROXY_CIDRS", "")
	t.Setenv("IDENTITY_IP_HOURLY_LIMIT", "")
	t.Setenv("IDENTITY_GLOBAL_HOURLY_LIMIT", "")
	t.Setenv("SPACE_LIMIT_PER_IDENTITY", "")
	t.Setenv("SESSION_LIMIT_PER_SPACE", "")
	t.Setenv("STORY_LIMIT_PER_SESSION", "")
}

func TestLoadConfigUsesFiniteAbuseLimitDefaults(t *testing.T) {
	baseConfigEnv(t)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	want := abuseLimits{
		IdentityIPHourly:       10,
		IdentityGlobalHourly:   500,
		LinkRedemptionIPHourly: 50,
		SpacesPerIdentity:      50,
		SessionsPerSpace:       500,
		DecksPerSpace:          20,
		KudosPerSpace:          500,
		StoriesPerSession:      500,
		LinksPerSession:        20,
	}
	if cfg.Limits != want {
		t.Fatalf("limits = %+v, want %+v", cfg.Limits, want)
	}
}

func TestLoadConfigRejectsNonPositiveAbuseLimits(t *testing.T) {
	for _, name := range []string{
		"IDENTITY_IP_HOURLY_LIMIT",
		"IDENTITY_GLOBAL_HOURLY_LIMIT",
		"LINK_REDEMPTION_IP_HOURLY_LIMIT",
		"SPACE_LIMIT_PER_IDENTITY",
		"SESSION_LIMIT_PER_SPACE",
		"STORY_LIMIT_PER_SESSION",
		"LINK_LIMIT_PER_SESSION",
	} {
		for _, value := range []string{"0", "-1", "many"} {
			t.Run(name+"="+value, func(t *testing.T) {
				baseConfigEnv(t)
				t.Setenv(name, value)
				if _, err := loadConfig(); err == nil {
					t.Fatalf("%s=%q was accepted", name, value)
				}
			})
		}
	}
}

func TestLoadConfigRequiresValidCIDRsWhenProxyTrustEnabled(t *testing.T) {
	for _, cidrs := range []string{"", "10.0.0.1", "10.0.0.0/8,not-a-cidr"} {
		t.Run(cidrs, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv("TRUST_PROXY_HEADERS", "true")
			t.Setenv("TRUSTED_PROXY_CIDRS", cidrs)
			if _, err := loadConfig(); err == nil {
				t.Fatalf("trusted proxy CIDRs %q were accepted", cidrs)
			}
		})
	}
}

// A default route in the allowlist is "trust the header from anyone" wearing a
// value, which is the bypass the setting exists to close. Only the default
// routes are refused: a wide prefix like a pod CIDR is the configuration that
// works on Kubernetes alongside a NetworkPolicy, and must keep working.
func TestLoadConfigRefusesADefaultRouteAsATrustedProxy(t *testing.T) {
	for _, cidrs := range []string{"0.0.0.0/0", "::/0", "10.0.0.0/8,0.0.0.0/0", " 0.0.0.0/0 "} {
		t.Run(cidrs, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv("TRUST_PROXY_HEADERS", "true")
			t.Setenv("TRUSTED_PROXY_CIDRS", cidrs)
			if _, err := loadConfig(); err == nil {
				t.Fatalf("default route %q was accepted as a trusted proxy", cidrs)
			}
		})
	}

	for _, cidrs := range []string{"10.42.0.0/16", "10.0.0.0/8", "2001:db8::/32", "127.0.0.1/32"} {
		t.Run("accepts "+cidrs, func(t *testing.T) {
			baseConfigEnv(t)
			t.Setenv("TRUST_PROXY_HEADERS", "true")
			t.Setenv("TRUSTED_PROXY_CIDRS", cidrs)
			if _, err := loadConfig(); err != nil {
				t.Fatalf("legitimate CIDR %q was refused: %v", cidrs, err)
			}
		})
	}
}

func TestLoadConfigParsesTrustedProxyCIDRs(t *testing.T) {
	baseConfigEnv(t)
	t.Setenv("TRUST_PROXY_HEADERS", "true")
	t.Setenv("TRUSTED_PROXY_CIDRS", "10.0.0.0/8, 2001:db8::/32")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.TrustedProxyCIDRs) != 2 || cfg.TrustedProxyCIDRs[0].String() != "10.0.0.0/8" || cfg.TrustedProxyCIDRs[1].String() != "2001:db8::/32" {
		t.Fatalf("trusted proxy CIDRs = %v", cfg.TrustedProxyCIDRs)
	}
}

func TestHTTPServerUsesBoundedTimeouts(t *testing.T) {
	srv := newHTTPServer("8080", http.NotFoundHandler())
	if srv.ReadHeaderTimeout != 10*time.Second || srv.ReadTimeout != 30*time.Second || srv.WriteTimeout != 30*time.Second || srv.IdleTimeout != 120*time.Second {
		t.Fatalf("timeouts = header %s read %s write %s idle %s", srv.ReadHeaderTimeout, srv.ReadTimeout, srv.WriteTimeout, srv.IdleTimeout)
	}
}

// oidcEnv is baseConfigEnv plus the minimum an OIDC instance needs, so a test
// can vary one org-mapping variable at a time.
func oidcEnv(t *testing.T) {
	t.Helper()
	baseConfigEnv(t)
	t.Setenv("AUTH_MODE", "oidc")
	t.Setenv("OIDC_ISSUER", "https://idp.example.test")
	t.Setenv("OIDC_CLIENT_ID", "parley")
	t.Setenv("OIDC_ORG_CLAIM", "")
	t.Setenv("PARLEY_DEFAULT_ORG_CLAIM", "")
	t.Setenv("PARLEY_BOOTSTRAP_ADMIN", "")
}

func TestLoadConfigOrgClaimDefaultsToGroups(t *testing.T) {
	oidcEnv(t)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OIDC.OrgClaim != "groups" {
		t.Errorf("OrgClaim = %q, want groups", cfg.OIDC.OrgClaim)
	}
	t.Setenv("OIDC_ORG_CLAIM", "roles")
	if cfg, err = loadConfig(); err != nil || cfg.OIDC.OrgClaim != "roles" {
		t.Errorf("OrgClaim = %q (%v), want roles", cfg.OIDC.OrgClaim, err)
	}
}

// TestLoadConfigBootstrapAdmin: the pair is the identity, so a value that is
// not a pair has to be refused rather than half-read — a bootstrap admin that
// silently never matches leaves an instance with no way to make the first org.
func TestLoadConfigBootstrapAdmin(t *testing.T) {
	oidcEnv(t)
	t.Setenv("PARLEY_BOOTSTRAP_ADMIN", "https://idp.example.test|abc-123")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BootstrapAdmin.Issuer != "https://idp.example.test" || cfg.BootstrapAdmin.Subject != "abc-123" {
		t.Errorf("BootstrapAdmin = %+v, want the issuer and subject either side of the pipe", cfg.BootstrapAdmin)
	}
	for _, bad := range []string{"abc-123", "https://idp.example.test|", "|abc-123", "a|b|c"} {
		t.Setenv("PARLEY_BOOTSTRAP_ADMIN", bad)
		if _, err := loadConfig(); err == nil {
			t.Errorf("PARLEY_BOOTSTRAP_ADMIN %q was accepted, want an error naming the issuer|subject form", bad)
		}
	}
}

func TestLoadConfigDefaultOrgClaim(t *testing.T) {
	oidcEnv(t)
	t.Setenv("PARLEY_DEFAULT_ORG_CLAIM", "parley-users")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultOrgClaim != "parley-users" {
		t.Errorf("DefaultOrgClaim = %q, want parley-users", cfg.DefaultOrgClaim)
	}
}
