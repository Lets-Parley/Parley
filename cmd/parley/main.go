package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lets-parley/parley/internal/api"
	"github.com/lets-parley/parley/internal/auth"
	"github.com/lets-parley/parley/internal/db"
)

// version is stamped at build time with -ldflags "-X main.version=…". An
// unstamped developer build honestly reports "dev".
var version = "dev"

type config struct {
	DatabaseURL       string
	Port              string
	BaseURL           *url.URL
	LogLevel          slog.Level
	AuthMode          string
	OIDC              auth.Config
	TrustProxy        bool
	TrustedProxyCIDRs []netip.Prefix
	Limits            abuseLimits
}

type abuseLimits = api.Limits

func loadConfig() (config, error) {
	cfg := config{
		Port: envOr("PORT", "8080"),
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is not set — set it to a Postgres connection string, e.g. postgres://parley:secret@localhost:5432/parley")
	}

	rawBase := envOr("BASE_URL", "http://localhost:8080")
	base, err := url.Parse(rawBase)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return cfg, fmt.Errorf("BASE_URL %q is not a valid URL — set it to the address users reach this server at, e.g. http://localhost:8080", rawBase)
	}
	cfg.BaseURL = base

	switch lv := strings.ToLower(envOr("LOG_LEVEL", "info")); lv {
	case "debug":
		cfg.LogLevel = slog.LevelDebug
	case "info":
		cfg.LogLevel = slog.LevelInfo
	case "warn":
		cfg.LogLevel = slog.LevelWarn
	case "error":
		cfg.LogLevel = slog.LevelError
	default:
		return cfg, fmt.Errorf("LOG_LEVEL %q is not one of debug, info, warn, error", lv)
	}

	// Only meaningful behind a proxy that sets the header itself. Exposed
	// directly, trusting it lets a caller pick their own address and walk
	// straight through the room-code throttle.
	trust, err := strconv.ParseBool(envOr("TRUST_PROXY_HEADERS", "false"))
	if err != nil {
		return cfg, fmt.Errorf("TRUST_PROXY_HEADERS %q is not a boolean — use true or false", os.Getenv("TRUST_PROXY_HEADERS"))
	}
	cfg.TrustProxy = trust
	if trust {
		raw := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDRS"))
		if raw == "" {
			return cfg, fmt.Errorf("TRUSTED_PROXY_CIDRS is not set — TRUST_PROXY_HEADERS=true needs the CIDRs of every trusted proxy hop")
		}
		for _, value := range strings.Split(raw, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
			if err != nil {
				return cfg, fmt.Errorf("TRUSTED_PROXY_CIDRS contains invalid CIDR %q", strings.TrimSpace(value))
			}
			cfg.TrustedProxyCIDRs = append(cfg.TrustedProxyCIDRs, prefix.Masked())
		}
	}

	limits := []struct {
		name     string
		fallback int
		set      func(int)
	}{
		{"IDENTITY_IP_HOURLY_LIMIT", 10, func(v int) { cfg.Limits.IdentityIPHourly = v }},
		{"IDENTITY_GLOBAL_HOURLY_LIMIT", 500, func(v int) { cfg.Limits.IdentityGlobalHourly = v }},
		{"SPACE_LIMIT_PER_IDENTITY", 50, func(v int) { cfg.Limits.SpacesPerIdentity = v }},
		{"SESSION_LIMIT_PER_SPACE", 500, func(v int) { cfg.Limits.SessionsPerSpace = v }},
		{"STORY_LIMIT_PER_SESSION", 500, func(v int) { cfg.Limits.StoriesPerSession = v }},
	}
	for _, limit := range limits {
		raw := envOr(limit.name, strconv.Itoa(limit.fallback))
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			return cfg, fmt.Errorf("%s %q is not a positive integer", limit.name, raw)
		}
		limit.set(value)
	}

	switch mode := strings.ToLower(envOr("AUTH_MODE", api.ModeOpen)); mode {
	case api.ModeOpen:
		cfg.AuthMode = api.ModeOpen
	case api.ModeOIDC:
		cfg.AuthMode = api.ModeOIDC
		cfg.OIDC = auth.Config{
			Issuer:       os.Getenv("OIDC_ISSUER"),
			ClientID:     os.Getenv("OIDC_CLIENT_ID"),
			ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"),
			RedirectURL:  strings.TrimSuffix(base.String(), "/") + "/auth/callback",
			Scopes:       strings.Fields(envOr("OIDC_SCOPES", "profile email")),
		}
		// No client secret: the provider registration is a public client and
		// PKCE alone ties the code to this browser, which is how Keycloak,
		// Zitadel and Entra register an app of this shape by default.
		for name, v := range map[string]string{
			"OIDC_ISSUER":    cfg.OIDC.Issuer,
			"OIDC_CLIENT_ID": cfg.OIDC.ClientID,
		} {
			if v == "" {
				return cfg, fmt.Errorf("%s is not set — AUTH_MODE=oidc needs it", name)
			}
		}
		if u, err := url.Parse(cfg.OIDC.Issuer); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return cfg, fmt.Errorf("OIDC_ISSUER %q is not a URL — use the issuer's base address, the one that serves /.well-known/openid-configuration", cfg.OIDC.Issuer)
		}
	default:
		return cfg, fmt.Errorf("AUTH_MODE %q is not one of open, oidc", mode)
	}

	return cfg, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe the running server's /readyz and exit 0 if ready")
	showVersion := flag.Bool("version", false, "print the build version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if *healthcheck {
		os.Exit(runHealthcheck())
	}

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "FATAL:", err)
		os.Exit(1)
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)

	secureCookies := cfg.BaseURL.Scheme == "https"
	log.Info("boot settings", bootFields(cfg, secureCookies)...)
	if cfg.AuthMode == api.ModeOIDC {
		log.Info("sign-in via identity provider",
			"issuer", cfg.OIDC.Issuer,
			"redirect_url", cfg.OIDC.RedirectURL,
			"scopes", strings.Join(cfg.OIDC.Scopes, " "),
		)
	}
	if secureCookies {
		log.Warn("BASE_URL is https: the app must actually be reached over HTTPS, or browsers will silently drop the session cookie and logins will appear to succeed but never persist")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, log)
	if err != nil {
		log.Error("FATAL: could not connect to Postgres — check DATABASE_URL and that the database is running", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Safe to run on every replica at once: Migrate serializes behind an
	// advisory lock, so simultaneous boots wait rather than race.
	if err := db.Migrate(ctx, pool, log, db.MigrationsFS); err != nil {
		log.Error("FATAL: database migration failed", "error", err)
		os.Exit(1)
	}

	opts := api.Options{
		// The signal context, so SIGTERM stops the cross-replica listener
		// along with everything else rather than leaving it dialling.
		Context:           ctx,
		SecureCookies:     secureCookies,
		AllowedOrigin:     cfg.BaseURL.Scheme + "://" + cfg.BaseURL.Host,
		AuthMode:          cfg.AuthMode,
		TrustProxyHeaders: cfg.TrustProxy,
		Version:           version,
		TrustedProxyCIDRs: cfg.TrustedProxyCIDRs,
		Limits:            cfg.Limits,
	}
	if cfg.AuthMode == api.ModeOIDC {
		// Discovery happens on the first sign-in rather than here: an identity
		// provider that is down should not keep this server from starting.
		opts.OIDC = auth.New(cfg.OIDC)
		// A one-time, non-gating diagnostic. A wrong issuer otherwise passes
		// every automated check and only surfaces when a person tries to sign
		// in, because discovery is deferred and /readyz deliberately ignores
		// it. This says so in the log without making the identity provider a
		// dependency of starting up.
		startIdentityProbe(ctx, log, opts.OIDC)
	}

	handler := api.Router(pool, opts)
	defer handler.Shutdown()
	srv := newHTTPServer(cfg.Port, handler)

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		handler.Shutdown()
		srv.Shutdown(shutCtx)
	}()

	log.Info("listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("FATAL: server exited", "error", err)
		os.Exit(1)
	}
	log.Info("shut down cleanly")
}

// bootFields is the boot line an operator reads to confirm what this process
// actually parsed, as opposed to what they meant to configure.
func bootFields(cfg config, secureCookies bool) []any {
	fields := []any{
		"version", version,
		"base_url", cfg.BaseURL.String(),
		"cookie_secure", secureCookies,
		"allowed_ws_origin", cfg.BaseURL.Scheme + "://" + cfg.BaseURL.Host,
		"port", cfg.Port,
		"auth_mode", cfg.AuthMode,
		"trust_proxy_headers", cfg.TrustProxy,
	}
	// "trust_proxy_headers=true" alone does not tell an operator which hops
	// were accepted, and a CIDR that failed to parse is exactly the mistake
	// that makes the whole feature silently do nothing.
	if cfg.TrustProxy {
		cidrs := make([]string, len(cfg.TrustedProxyCIDRs))
		for i, prefix := range cfg.TrustedProxyCIDRs {
			cidrs[i] = prefix.String()
		}
		fields = append(fields, "trusted_proxy_cidrs", cidrs)
	}
	return fields
}

// identityProbeWindow bounds the boot probe. Discovery has its own 15s window;
// this is the outer bound on the goroutine as a whole.
const identityProbeWindow = 20 * time.Second

// identityWarmer is the slice of *auth.Provider the probe needs, so the probe
// can be tested without an identity provider.
type identityWarmer interface {
	Issuer() string
	Warm(context.Context) error
}

// startIdentityProbe runs the probe in the background and returns immediately.
// Awaiting it would delay ListenAndServe by up to the discovery window on every
// boot with a slow identity provider, which is precisely the coupling deferred
// discovery exists to prevent.
func startIdentityProbe(ctx context.Context, log *slog.Logger, provider identityWarmer) {
	go probeIdentityProvider(ctx, log, provider)
}

func probeIdentityProvider(ctx context.Context, log *slog.Logger, provider identityWarmer) {
	ctx, cancel := context.WithTimeout(ctx, identityProbeWindow)
	defer cancel()
	if err := provider.Warm(ctx); err != nil {
		log.Warn("identity provider is not reachable — sign-ins will fail until it recovers, but this does not stop the server and does not affect /readyz",
			"issuer", provider.Issuer(),
			"error", err,
		)
		return
	}
	// Scope the claim: discovery only proves the issuer answered. A wrong
	// client ID or secret still fails later, at token exchange.
	log.Info("identity provider is reachable — discovery succeeded; the client ID and secret are not checked until a sign-in reaches token exchange",
		"issuer", provider.Issuer(),
	)
}

func newHTTPServer(port string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}

func runHealthcheck() int {
	port := envOr("PORT", "8080")
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/readyz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "not ready:", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "not ready: status", resp.StatusCode)
		return 1
	}
	return 0
}
