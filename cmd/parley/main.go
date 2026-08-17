package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jacorbello/parley/internal/api"
	"github.com/jacorbello/parley/internal/db"
)

type config struct {
	DatabaseURL string
	Port        string
	BaseURL     *url.URL
	LogLevel    slog.Level
}

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
	flag.Parse()

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
	log.Info("boot settings",
		"base_url", cfg.BaseURL.String(),
		"cookie_secure", secureCookies,
		"allowed_ws_origin", cfg.BaseURL.Scheme+"://"+cfg.BaseURL.Host,
		"port", cfg.Port,
	)
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

	if err := db.AcquireBootLock(ctx, pool); err != nil {
		log.Error("FATAL: another parley instance holds the hub lock; this build is single-replica only — scale to one replica or stop the other instance", "error", err)
		os.Exit(1)
	}

	if err := db.Migrate(ctx, pool, log); err != nil {
		log.Error("FATAL: database migration failed", "error", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           api.Router(pool),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutCtx)
	}()

	log.Info("listening", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("FATAL: server exited", "error", err)
		os.Exit(1)
	}
	log.Info("shut down cleanly")
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
