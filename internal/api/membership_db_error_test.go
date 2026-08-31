package api

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

// isMemberSQL is the Spaces.IsMember statement. A tracer that cancels only
// this query leaves every other lookup on the request path healthy, so a
// membership outage is distinguishable from a missing session or space.
const isMemberSQL = "select exists (select 1 from members where space_id = $1 and user_id = $2)"

// armableCancelOnQuery cancels matching queries only after arm(), so fixture
// setup (create space, join, mint session) can use the same pool the
// assertion later poisons.
type armableCancelOnQuery struct {
	match string
	mu    sync.Mutex
	armed bool
}

func (c *armableCancelOnQuery) arm() {
	c.mu.Lock()
	c.armed = true
	c.mu.Unlock()
}

func (c *armableCancelOnQuery) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	c.mu.Lock()
	armed := c.armed
	c.mu.Unlock()
	if armed && strings.Contains(data.SQL, c.match) {
		cctx, cancel := context.WithCancel(ctx)
		cancel()
		return cctx
	}
	return ctx
}

func (c *armableCancelOnQuery) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func membershipFaultServer(t *testing.T) (*httptest.Server, *armableCancelOnQuery, *bytes.Buffer) {
	t.Helper()
	tracer := &armableCancelOnQuery{match: isMemberSQL}
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	pool := tracedTestPool(t, tracer)
	srv := testServerWith(t, pool, Options{AllowedOrigin: testOrigin})
	return srv, tracer, &logs
}

// A database fault during requireSessionMember must surface as a logged 5xx,
// not the 404 a non-member gets. Folding the two hid outages behind a normal
// "no such session" response with nothing in the logs (#373).
func TestRequireSessionMemberReportsDatabaseErrorNot404(t *testing.T) {
	srv, tracer, logs := membershipFaultServer(t)
	fac, _, id := setupSession(t, srv, "Membership Fault Session")
	tracer.arm()

	resp, body := doJSON(t, srv, "GET", "/api/sessions/"+id, "", fac)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %v)", resp.StatusCode, body)
	}
	if body["error"] == "no such session" {
		t.Fatalf("body folded the outage into the non-member message: %v", body)
	}
	if !strings.Contains(logs.String(), "checking session membership") {
		t.Fatalf("expected the membership failure to be logged, got %q", logs.String())
	}
}

func TestRequireSessionMemberStill404ForNonMember(t *testing.T) {
	srv := testServer(t)
	_, _, id := setupSession(t, srv, "Membership NonMember Session")
	outsider := signup(t, srv, "Out")

	resp, body := doJSON(t, srv, "GET", "/api/sessions/"+id, "", outsider)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if body["error"] != "no such session" {
		t.Fatalf("body = %v, want no such session", body)
	}
}

// Same shape on the WebSocket upgrade path: IsMember outage → 500 + log,
// stranger → 404 with the existing plain-text body.
func TestHandleWSReportsMembershipDatabaseErrorNot404(t *testing.T) {
	srv, tracer, logs := membershipFaultServer(t)
	fac, _, id := setupSession(t, srv, "Membership Fault WS")
	tracer.arm()

	_, resp, err := dialWS(t, srv, id, fac, testOrigin)
	if err == nil {
		t.Fatal("websocket upgrade succeeded under a membership outage")
	}
	if resp == nil || resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("ws status = %v, want 500", resp)
	}
	if !strings.Contains(logs.String(), "checking session membership") {
		t.Fatalf("expected the membership failure to be logged, got %q", logs.String())
	}
}

func TestHandleWSStill404ForNonMember(t *testing.T) {
	srv := testServer(t)
	_, _, id := setupSession(t, srv, "Membership NonMember WS")
	outsider := signup(t, srv, "Out")

	_, resp, err := dialWS(t, srv, id, outsider, testOrigin)
	if err == nil {
		t.Fatal("outsider websocket upgrade succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("ws status = %v, want 404", resp)
	}
}

// handleCreateSession has the same folded branch on space membership.
func TestHandleCreateSessionReportsMembershipDatabaseErrorNot404(t *testing.T) {
	srv, tracer, logs := membershipFaultServer(t)
	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Membership Fault Create", fac)
	slug := sp["slug"].(string)
	tracer.arm()

	resp, body := createSession(t, srv, slug, "poker", "Sprint", fac)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body %v)", resp.StatusCode, body)
	}
	if body["error"] == "no such space" {
		t.Fatalf("body folded the outage into the non-member message: %v", body)
	}
	if !strings.Contains(logs.String(), "checking space membership") {
		t.Fatalf("expected the membership failure to be logged, got %q", logs.String())
	}
}

func TestHandleCreateSessionStill404ForNonMember(t *testing.T) {
	srv := testServer(t)
	fac := signup(t, srv, "Fay")
	_, sp := createSpace(t, srv, "Membership NonMember Create", fac)
	slug := sp["slug"].(string)
	outsider := signup(t, srv, "Out")

	resp, body := createSession(t, srv, slug, "poker", "Sprint", outsider)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if body["error"] != "no such space" {
		t.Fatalf("body = %v, want no such space", body)
	}
}
