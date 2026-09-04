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
	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/store"
)

// version is stamped at build time with -ldflags "-X main.version=…". An
// unstamped developer build honestly reports "dev".
var version = "dev"

type config struct {
	DatabaseURL string
	// DBSSLMode is the sslmode DATABASE_URL resolves to, echoed on the boot
	// line so an operator can confirm the database session is encrypted.
	DBSSLMode string
	// DBRootCert is the sslrootcert the server certificate is verified
	// against. Empty with sslmode=require means no verification at all.
	DBRootCert string
	Port       string
	BaseURL    *url.URL
	LogLevel   slog.Level
	AuthMode   string
	OIDC       auth.Config
	// DefaultOrgClaim, when set, points the default org at an identity-provider
	// group so a fresh instance has something for a claim to match.
	DefaultOrgClaim string
	// BootstrapAdmin is the (issuer, subject) pair granted admin of the
	// default org at its first sign-in.
	BootstrapAdmin    api.BootstrapAdmin
	TrustProxy        bool
	TrustedProxyCIDRs []netip.Prefix
	Limits            abuseLimits
	// PluginSecretKey is the base64 32-byte key plugin secrets are encrypted
	// with. Empty means secrets are unavailable, and a plugin that asks for
	// them fails to install rather than storing them in the clear.
	PluginSecretKey string
	// PluginEventRetention is how long a fully-delivered plugin event is kept.
	PluginEventRetention time.Duration
	// PluginDir is the directory plugin bundles are read from. Empty means no
	// plugin host runs at all, which is the default: an instance that has not
	// been given plugins does not gain a WASM runtime by upgrading.
	PluginDir string
	// PluginLimits is the containment budget one plugin call gets.
	PluginLimits plugin.HostConfig
}

type abuseLimits = api.Limits

func loadConfig() (config, error) {
	// The file is merged first and only fills gaps: everything below reads the
	// environment, and the environment still wins.
	if err := applyConfigFile(); err != nil {
		return config{}, err
	}

	cfg := config{
		Port: envOr("PORT", "8080"),
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is not set — set it to a Postgres connection string, e.g. postgres://parley:secret@localhost:5432/parley")
	}

	// pgx defaults sslmode to "prefer", which negotiates TLS if the server
	// offers it and quietly drops to plaintext if it does not. Refuse that
	// rather than let a deployment discover it was unencrypted all along.
	cfg.DBSSLMode, cfg.DBRootCert = db.TLSSettings(cfg.DatabaseURL)
	allowPlaintext, err := strconv.ParseBool(envOr("DATABASE_ALLOW_PLAINTEXT", "false"))
	if err != nil {
		return cfg, fmt.Errorf("DATABASE_ALLOW_PLAINTEXT %q is not a boolean — use true or false", os.Getenv("DATABASE_ALLOW_PLAINTEXT"))
	}
	if err := db.CheckTLS(cfg.DBSSLMode, allowPlaintext); err != nil {
		return cfg, err
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
			// A default route — 0.0.0.0/0 or ::/0 — trusts a forwarded
			// client address from every host that can reach the socket,
			// which is the bypass TRUST_PROXY_HEADERS exists to prevent
			// wearing a value. Refused specifically, and only this: a wide
			// prefix like a /16 is a legitimate pod CIDR behind a
			// NetworkPolicy, and refusing that would break the only
			// configuration Kubernetes leaves you.
			if prefix.Bits() == 0 {
				return cfg, fmt.Errorf("TRUSTED_PROXY_CIDRS contains %q, a default route — that trusts X-Forwarded-For from every address, which is the throttle bypass TRUST_PROXY_HEADERS exists to prevent. List only the proxy hops", strings.TrimSpace(value))
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
		{"LINK_REDEMPTION_IP_HOURLY_LIMIT", 50, func(v int) { cfg.Limits.LinkRedemptionIPHourly = v }},
		{"SPACE_LIMIT_PER_IDENTITY", 50, func(v int) { cfg.Limits.SpacesPerIdentity = v }},
		{"SESSION_LIMIT_PER_SPACE", 500, func(v int) { cfg.Limits.SessionsPerSpace = v }},
		{"DECK_LIMIT_PER_SPACE", 20, func(v int) { cfg.Limits.DecksPerSpace = v }},
		{"KUDO_LIMIT_PER_SPACE", 500, func(v int) { cfg.Limits.KudosPerSpace = v }},
		{"STORY_LIMIT_PER_SESSION", 500, func(v int) { cfg.Limits.StoriesPerSession = v }},
		{"LINK_LIMIT_PER_SESSION", 20, func(v int) { cfg.Limits.LinksPerSession = v }},
	}
	for _, limit := range limits {
		raw := envOr(limit.name, strconv.Itoa(limit.fallback))
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			return cfg, fmt.Errorf("%s %q is not a positive integer", limit.name, raw)
		}
		limit.set(value)
	}

	cfg.PluginSecretKey = strings.TrimSpace(os.Getenv("PLUGIN_SECRET_KEY"))
	if cfg.PluginSecretKey != "" {
		if _, err := plugin.NewCipher(cfg.PluginSecretKey); err != nil {
			return cfg, fmt.Errorf("PLUGIN_SECRET_KEY is not usable: %w", err)
		}
	}
	retention, err := time.ParseDuration(envOr("PLUGIN_EVENT_RETENTION", "168h"))
	if err != nil || retention <= 0 {
		return cfg, fmt.Errorf("PLUGIN_EVENT_RETENTION %q is not a positive duration — use a Go duration such as 168h", os.Getenv("PLUGIN_EVENT_RETENTION"))
	}

	cfg.PluginDir = strings.TrimSpace(os.Getenv("PLUGIN_DIR"))
	callTimeout, err := time.ParseDuration(envOr("PLUGIN_CALL_TIMEOUT", plugin.DefaultCallTimeout.String()))
	if err != nil || callTimeout <= 0 {
		return cfg, fmt.Errorf("PLUGIN_CALL_TIMEOUT %q is not a positive duration — use a Go duration such as 2s", os.Getenv("PLUGIN_CALL_TIMEOUT"))
	}
	cfg.PluginLimits.CallTimeout = callTimeout
	for _, limit := range []struct {
		name string
		def  int
		set  func(int)
	}{
		{"PLUGIN_MEMORY_PAGES", int(plugin.DefaultMemoryPages), func(v int) { cfg.PluginLimits.MemoryPages = uint32(v) }},
		{"PLUGIN_MAX_CONCURRENT_CALLS", plugin.DefaultMaxConcurrent, func(v int) { cfg.PluginLimits.MaxConcurrentCalls = v }},
		{"PLUGIN_MAX_CALLS_PER_PLUGIN", plugin.DefaultPerInstall, func(v int) { cfg.PluginLimits.MaxConcurrentPerInstall = v }},
		{"PLUGIN_MODULE_CACHE_SIZE", plugin.DefaultCachedModules, func(v int) { cfg.PluginLimits.MaxCachedModules = v }},
	} {
		raw := envOr(limit.name, strconv.Itoa(limit.def))
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			return cfg, fmt.Errorf("%s %q is not a positive integer", limit.name, raw)
		}
		limit.set(value)
	}
	cfg.PluginEventRetention = retention

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
			OrgClaim:     envOr("OIDC_ORG_CLAIM", auth.DefaultOrgClaim),
		}
		cfg.DefaultOrgClaim = strings.TrimSpace(os.Getenv("PARLEY_DEFAULT_ORG_CLAIM"))
		// The (issuer, subject) pair is the identity — 0009_federated_identity
		// makes it so, and the users row does not exist until this person
		// first signs in. Half a pair can never match, and a bootstrap admin
		// that silently never matches leaves an instance with no way to make
		// its first org, so it is refused rather than read loosely.
		if raw := strings.TrimSpace(os.Getenv("PARLEY_BOOTSTRAP_ADMIN")); raw != "" {
			issuer, subject, ok := strings.Cut(raw, "|")
			if !ok || issuer == "" || subject == "" || strings.Contains(subject, "|") {
				return cfg, fmt.Errorf("PARLEY_BOOTSTRAP_ADMIN %q is not an issuer and subject pair — use the form https://idp.example/realm|the-sub-claim", raw)
			}
			cfg.BootstrapAdmin = api.BootstrapAdmin{Issuer: issuer, Subject: subject}
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
	warnAboutDatabaseTLS(cfg, log)
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

	// Bootstrap, after the migration that creates the default org and before
	// the first request can map a claim against it.
	if cfg.DefaultOrgClaim != "" {
		if err := (&store.Orgs{Pool: pool}).SetClaimValue(ctx, store.DefaultOrgSlug, cfg.DefaultOrgClaim); err != nil {
			log.Error("FATAL: could not point the default org at PARLEY_DEFAULT_ORG_CLAIM", "error", err)
			os.Exit(1)
		}
	}

	// The plugin foundations. Nothing runs a plugin yet — the outbox and job
	// workers get their handlers from the plugin host — but retention and the
	// quota reconciliation pass are the instance's own housekeeping and run
	// from the start, so the tables cannot grow unbounded before the host
	// arrives.
	plugins := &plugin.Store{Pool: pool}
	if cfg.PluginSecretKey != "" {
		cipher, err := plugin.NewCipher(cfg.PluginSecretKey)
		if err != nil {
			log.Error("FATAL: PLUGIN_SECRET_KEY is not usable", "error", err)
			os.Exit(1)
		}
		plugins.Cipher = cipher
	}
	go plugins.RunRetention(ctx, cfg.PluginEventRetention, time.Hour, log)

	// The host, and with it the outbox and job handlers. Without PLUGIN_DIR
	// there is no host: the workers keep their nil handlers and drain nothing,
	// so an instance with no plugins never instantiates a WASM runtime.
	var pluginHost *plugin.Host
	if runtime := plugin.NewRuntime(plugins, cfg.PluginDir, cfg.PluginLimits, log); runtime != nil {
		defer runtime.Close()
		runtime.Start(ctx)
		pluginHost = runtime.Host
	}

	opts := apiOptions(ctx, cfg, secureCookies, plugins, pluginHost)
	if opts.OIDC != nil {
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

// apiOptions maps a parsed config onto the options the HTTP layer is built
// from. It is a separate function rather than a literal inside main because
// main is the one caller that matters and the one caller no test can reach:
// a field the HTTP layer gates a feature on — PluginDir was exactly this — is
// dead in the shipped binary if this mapping omits it, and every handler test
// that constructs api.Options itself will still pass. Extracted, the mapping
// can be exercised directly, and an app built from it can be driven over HTTP.
func apiOptions(ctx context.Context, cfg config, secureCookies bool, plugins *plugin.Store, pluginHost *plugin.Host) api.Options {
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
		BootstrapAdmin:    cfg.BootstrapAdmin,
		// Without this the plugin UI frame route and the room's panel list
		// both take their empty-directory early return, and the whole plugin
		// UI feature is dead however well the WASM host is wired.
		PluginDir: cfg.PluginDir,
		// The administration surface reads the store even with no host
		// running, so an operator on an instance without PLUGIN_DIR still sees
		// what is installed and is told the host is not running.
		Plugins:    plugins,
		PluginHost: pluginHost,
	}
	if cfg.AuthMode == api.ModeOIDC {
		// Discovery happens on the first sign-in rather than here: an identity
		// provider that is down should not keep this server from starting.
		opts.OIDC = auth.New(cfg.OIDC)
	}
	return opts
}

// bootFields is the boot line an operator reads to confirm what this process
// actually parsed, as opposed to what they meant to configure.
// warnAboutDatabaseTLS names the modes that look encrypted and are not the
// whole control. sslmode=require negotiates TLS and then accepts whatever
// certificate is offered, so anyone who can redirect the connection can be
// Postgres.
func warnAboutDatabaseTLS(cfg config, log *slog.Logger) {
	if cfg.DBSSLMode == "require" && cfg.DBRootCert == "" {
		log.Warn("DATABASE_URL uses sslmode=require without sslrootcert: the connection is encrypted but the database server's certificate is never checked, so a redirected connection can be impersonated. Use sslmode=verify-full with sslrootcert pointing at your CA")
	}
}

func bootFields(cfg config, secureCookies bool) []any {
	fields := []any{
		"version", version,
		"base_url", cfg.BaseURL.String(),
		"cookie_secure", secureCookies,
		"allowed_ws_origin", cfg.BaseURL.Scheme + "://" + cfg.BaseURL.Host,
		"port", cfg.Port,
		"auth_mode", cfg.AuthMode,
		"db_sslmode", cfg.DBSSLMode,
		"trust_proxy_headers", cfg.TrustProxy,
		"plugin_secrets", cfg.PluginSecretKey != "",
		"plugin_event_retention", cfg.PluginEventRetention.String(),
		"plugin_dir", cfg.PluginDir,
		"plugin_call_timeout", cfg.PluginLimits.CallTimeout.String(),
		"plugin_memory_pages", cfg.PluginLimits.MemoryPages,
		"plugin_max_concurrent_calls", cfg.PluginLimits.MaxConcurrentCalls,
		"plugin_max_calls_per_plugin", cfg.PluginLimits.MaxConcurrentPerInstall,
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
