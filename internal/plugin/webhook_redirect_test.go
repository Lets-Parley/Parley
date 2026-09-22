package plugin

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/standup"
)

// A receiver that answers 307 must not count as a delivery. Following the
// redirect would POST an empty body to the next hop and, on a final 2xx,
// mark the event delivered.
func TestARedirectIsNotADeliveredWebhook(t *testing.T) {
	pool := redirectTestPool(t)
	ctx := context.Background()

	var landed int
	var port string
	_, port = serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/landed" {
			landed++
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Location", "https://hooks.example:"+port+"/landed")
		w.WriteHeader(http.StatusTemporaryRedirect)
	})

	f := testFetcher(t, map[string]string{"hooks.example": ""})
	hooks := &standup.Webhooks{
		Pool:    pool,
		BaseURL: "https://parley.example",
		Seal:    func(s string) ([]byte, []byte, error) { return []byte("n"), []byte(s), nil },
		Open:    func(_, c []byte) (string, error) { return string(c), nil },
		Send: func(ctx context.Context, u string, h map[string]string, b []byte) (int, error) {
			return f.PostNoFollow(ctx, []string{"hooks.example"}, u, h, b)
		},
	}
	var spaceID, userID, sessID string
	if err := pool.QueryRow(ctx, "insert into spaces (slug, name) values ('webhook-redirect', 'Webhook Redirect') returning id::text").Scan(&spaceID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into users (name) values ('Ada') returning id::text").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		insert into sessions (space_id, kind, title, config, facilitator_id)
		values ($1, 'standup', 'Daily', '{"mode":"async"}', $2) returning id::text`, spaceID, userID).Scan(&sessID); err != nil {
		t.Fatal(err)
	}
	if err := hooks.Put(ctx, spaceID, "", "https://hooks.example:"+port+"/in", "s3cret"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "update standup_webhooks set created_at = now() - interval '1 minute'"); err != nil {
		t.Fatal(err)
	}
	if err := hooks.Enqueue(ctx); err != nil {
		t.Fatal(err)
	}
	if err := hooks.Deliver(ctx); err != nil {
		t.Fatal(err)
	}
	if landed != 0 {
		t.Fatalf("the redirect target was requested %d times", landed)
	}
	var delivered bool
	var attempts int
	var lastError string
	if err := pool.QueryRow(ctx, `
		select delivered_at is not null, attempts, coalesce(last_error, '')
		from standup_webhook_deliveries where session_id = $1`, sessID).Scan(&delivered, &attempts, &lastError); err != nil {
		t.Fatal(err)
	}
	if delivered || attempts != 1 || !strings.Contains(lastError, "307") {
		t.Fatalf("delivered=%v attempts=%d last_error=%q; a 307 must be one failed attempt", delivered, attempts, lastError)
	}
}

func redirectTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx, pool, slog.New(slog.NewTextHandler(os.Stderr, nil)), db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	return pool
}
