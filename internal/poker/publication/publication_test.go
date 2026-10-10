package publication

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lets-parley/parley/internal/db"
	"github.com/lets-parley/parley/internal/dbtest"
	"github.com/lets-parley/parley/internal/store"
)

type fakeProvider struct {
	cap              Capability
	remote           map[string]string
	calls            map[string]int
	fail             map[string]bool
	unknown          map[string]bool
	ambiguous        map[string]bool
	observations     map[string]Observation
	nonblankDefaults map[string]bool
	denied           map[string]bool
	after            func(Step)
	onInspect        func(Step)
}

func (f *fakeProvider) Capability(context.Context, Scope) (Capability, error) { return f.cap, nil }
func (f *fakeProvider) Inspect(_ context.Context, _ Scope, step Step) (Observation, error) {
	if f.onInspect != nil {
		f.onInspect(step)
	}
	if observation, ok := f.observations[step.Key]; ok {
		if f.ambiguous[step.Key] {
			return observation, errors.New("token secret provider response")
		}
		return observation, nil
	}
	if f.ambiguous[step.Key] {
		return Observation{}, errors.New("token secret provider response")
	}
	key := step.Key
	if step.PairKey != "" {
		key = step.PairKey
	}
	id, ok := f.remote[key]
	if step.Kind == "remove-dependency" {
		ok = !ok
	}
	if step.Kind == "estimate" && step.Value == "" {
		ok = !f.nonblankDefaults[step.Key]
	}
	return Observation{Known: true, Matches: ok, MutationAllowed: !f.denied[step.Key], RemoteID: id}, nil
}
func (f *fakeProvider) Apply(_ context.Context, _ Scope, step Step) (Outcome, error) {
	f.calls[step.Key]++
	if f.after != nil {
		f.after(step)
	}
	if f.fail[step.Key] {
		return Failed, nil
	}
	key := step.Key
	if step.PairKey != "" {
		key = step.PairKey
	}
	if step.Kind == "remove-dependency" {
		delete(f.remote, key)
	} else {
		f.remote[key] = "remote-" + step.Key
	}
	if f.unknown[step.Key] {
		return Unknown, errors.New("token secret raw response")
	}
	return Confirmed, nil
}
func fixture(t *testing.T) (*Engine, Scope, Request, *fakeProvider) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err = db.Migrate(ctx, pool, slog.New(slog.NewTextHandler(io.Discard, nil)), db.MigrationsFS); err != nil {
		t.Fatal(err)
	}
	_, hash := store.NewToken()
	u, err := (&store.Users{Pool: pool}).Create(ctx, t.Name(), hash)
	if err != nil {
		t.Fatal(err)
	}
	var org store.Org
	err = pool.QueryRow(ctx, `insert into orgs(slug,name,claim_value) values($1,'Publication test',$1) returning id::text`, "pub-"+u.ID).Scan(&org.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = (&store.Orgs{Pool: pool}).AddMember(ctx, org.ID, u.ID, "member"); err != nil {
		t.Fatal(err)
	}
	sp, err := (&store.Spaces{Pool: pool}).Create(ctx, org.ID, t.Name(), "pub-"+u.ID, "", u.ID, store.VisibilityPrivate, 50)
	if err != nil {
		t.Fatal(err)
	}
	sess, err := (&store.Sessions{Pool: pool}).Create(ctx, sp.ID, "poker", t.Name(), []byte(`{"deck":"fibonacci"}`), u.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	var parent string
	if err = pool.QueryRow(ctx, `insert into stories(session_id,title,planning_role,coverage,position) values($1,'Original','context','full',0) returning id::text`, sess.ID).Scan(&parent); err != nil {
		t.Fatal(err)
	}
	req := Request{ParentID: parent}
	for i, title := range []string{"API", "Permissions", "UI"} {
		var id string
		if err = pool.QueryRow(ctx, `insert into stories(session_id,parent_id,title,estimate,accepted_scope_revision,estimate_provenance,position) values($1,$2,$3,$4,0,'facilitator-set',1) returning id::text`, sess.ID, parent, title, []any{"3", "5", nil}[i]).Scan(&id); err != nil {
			t.Fatal(err)
		}
		req.Children = append(req.Children, id)
	}
	for _, blocker := range req.Children[:2] {
		if _, err = pool.Exec(ctx, `insert into poker_dependencies(session_id,parent_id,blocker_id,dependent_id) values($1,$2,$3,$4)`, sess.ID, parent, blocker, req.Children[2]); err != nil {
			t.Fatal(err)
		}
	}
	f := &fakeProvider{cap: Capability{Verified: true, Generation: "1", Destination: "github:test/repo", IssueType: "Task", ParentID: "remote-parent", ParentDisposition: "excluded-from-counting", FieldID: "points", Mapping: map[string]string{"3": "3", "5": "5"}}, remote: map[string]string{}, calls: map[string]int{}, fail: map[string]bool{}, unknown: map[string]bool{}, ambiguous: map[string]bool{}}
	return &Engine{Pool: pool, Provider: f}, Scope{OrgID: org.ID, SpaceID: sp.ID, SessionID: sess.ID, PrincipalID: u.ID}, req, f
}
func approve(t *testing.T, e *Engine, s Scope, r Request) Review {
	t.Helper()
	p, err := e.Preview(context.Background(), s, r)
	if err != nil {
		t.Fatal(err)
	}
	r.Fingerprint = p.Fingerprint
	v, err := e.Approve(context.Background(), s, r)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func stepOf(t *testing.T, v Review, kind string, index int) Step {
	t.Helper()
	for _, step := range v.Steps {
		if step.Kind == kind {
			if index == 0 {
				return step
			}
			index--
		}
	}
	t.Fatalf("missing %s", kind)
	return Step{}
}
func TestPublicationIndependentReceiptsAndReplay(t *testing.T) {
	e, s, r, f := fixture(t)
	v := approve(t, e, s, r)
	if len(v.Steps) != 11 {
		t.Fatalf("steps %d, want 3 create + 3 parent + 3 estimate + 2 dependencies", len(v.Steps))
	}
	bad := stepOf(t, v, "dependency", 1)
	f.fail[bad.Key] = true
	if err := e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err := e.Receipts(context.Background(), s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range receipts {
		if receipt.Key == bad.Key {
			if receipt.State != Failed {
				t.Fatal(receipt)
			}
		} else if receipt.State != Confirmed {
			t.Fatal(receipt)
		}
	}
	f.fail[bad.Key] = false
	if err = e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	for key, n := range f.calls {
		want := 1
		if key == bad.Key {
			want = 2
		}
		if n != want {
			t.Fatalf("%s: %d calls want %d", key, n, want)
		}
	}
	if err = e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[bad.Key] != 2 {
		t.Fatal("replay repeated a confirmed operation")
	}
}
func TestPublicationCrashAndUnknownNeverBlindlyRecreate(t *testing.T) {
	e, s, r, f := fixture(t)
	v := approve(t, e, s, r)
	create := stepOf(t, v, "create", 0)
	// A process may die after committing the dispatch intent and remote write.
	if _, err := e.Pool.Exec(context.Background(), `update poker_publication_steps set state='unknown',remote_id=null where operation_key=$1`, create.Key); err != nil {
		t.Fatal(err)
	}
	f.remote[create.Key] = "original-id"
	f.unknown[stepOf(t, v, "dependency", 0).Key] = true
	if err := e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[create.Key] != 0 {
		t.Fatal("recreated remote issue after lost receipt")
	}
	if err := e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	for key, n := range f.calls {
		if n != 1 {
			t.Fatalf("replayed %s %d times", key, n)
		}
	}
	receipts, err := e.Receipts(context.Background(), s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(receipts)
	if strings.Contains(string(raw), "secret") || strings.Contains(string(raw), "token") {
		t.Fatal("provider error leaked")
	}
}
func TestPublicationMissingEndpointsAndDeclinedBlocker(t *testing.T) {
	e, s, r, f := fixture(t)
	r.Children = r.Children[2:]
	v := approve(t, e, s, r)
	if err := e.Run(context.Background(), s, v.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err := e.Receipts(context.Background(), s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range receipts {
		if receipt.Kind == "dependency" && receipt.State != Waiting {
			t.Fatal(receipt)
		}
	}
	e2, s2, r2, f2 := fixture(t)
	v2 := approve(t, e2, s2, r2)
	create := stepOf(t, v2, "create", 0)
	f2.ambiguous[create.Key] = true
	if err = e2.Run(context.Background(), s2, v2.ID); err != nil {
		t.Fatal(err)
	}
	if f2.calls[create.Key] != 0 {
		t.Fatal("unknown lookup caused create")
	}
	receipts2, err := e2.Receipts(context.Background(), s2, v2.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range receipts2 {
		if receipt.Key == create.Key && receipt.State != Unknown {
			t.Fatalf("lookup error must remain unknown, got %s", receipt.State)
		}
	}

	if len(f.calls) != 2 {
		t.Fatalf("unselected blocker published: %v", f.calls)
	}
}
func TestPublicationReviewInvalidationAndRedaction(t *testing.T) {
	for _, change := range []string{"content", "estimate", "graph", "destination", "generation", "capability", "revocation", "ended", "removed", "parent"} {
		t.Run(change, func(t *testing.T) {
			e, s, r, f := fixture(t)
			v := approve(t, e, s, r)
			ctx := context.Background()
			var err error
			switch change {
			case "content":
				_, err = e.Pool.Exec(ctx, `update stories set title='Changed',content_revision=content_revision+1 where id=$1`, r.Children[0])
			case "estimate":
				_, err = e.Pool.Exec(ctx, `update stories set estimate='8' where id=$1`, r.Children[0])
			case "graph":
				_, err = e.Pool.Exec(ctx, `update stories set dependency_revision=dependency_revision+1 where id=$1`, r.ParentID)
			case "destination":
				f.cap.Destination = "github:other/repo"
			case "generation":
				f.cap.Generation = "2"
			case "capability":
				f.cap.Verified = false
			case "revocation":
				_, err = e.Pool.Exec(ctx, `update org_members set revoked_at=now() where org_id=$1 and user_id=$2`, s.OrgID, s.PrincipalID)
			case "ended":
				_, err = e.Pool.Exec(ctx, `update sessions set ended_at=now() where id=$1`, s.SessionID)
			case "removed":
				_, err = e.Pool.Exec(ctx, `update stories set removed_at=now() where id=$1`, r.Children[0])
			case "parent":
				f.cap.ParentDisposition = "unknown"
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = e.Run(ctx, s, v.ID); err == nil {
				t.Fatal("stale approval dispatched")
			}
			if len(f.calls) != 0 {
				t.Fatal("remote write after invalidation")
			}
			if change == "revocation" {
				if receipts, err := e.Receipts(ctx, s, v.ID); err == nil || len(receipts) != 0 {
					t.Fatal("revoked receipt content returned")
				}
			}
		})
	}
}
func TestPublicationRetainsIdentitiesOnCloseAndRestore(t *testing.T) {
	e, s, r, f := fixture(t)
	v := approve(t, e, s, r)
	ctx := context.Background()
	if err := e.Run(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	before, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.Pool.Exec(ctx, `update sessions set ended_at=now() where id=$1`, s.SessionID); err != nil {
		t.Fatal(err)
	}
	after, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if string(a) != string(b) {
		t.Fatal("closure changed receipts")
	}
	f.cap.Verified = false
	after, err = e.Receipts(ctx, s, v.ID)
	if err != nil || len(after) != len(before) {
		t.Fatal("disable erased receipts")
	}
	if _, err = e.Pool.Exec(ctx, `update sessions set ended_at=null where id=$1`, s.SessionID); err != nil {
		t.Fatal(err)
	}
	f.cap.Verified = true
	fresh := approve(t, e, s, r)
	if err = e.Run(ctx, s, fresh.ID); err != nil {
		t.Fatal(err)
	}
	for key, n := range f.calls {
		if n != 1 {
			t.Fatalf("reopen recreated step %s", key)
		}
	}
}
func TestPublicationForeignScopeAndStaleApproval(t *testing.T) {
	e, s, r, _ := fixture(t)
	v := approve(t, e, s, r)
	ctx := context.Background()
	_, other, _, _ := fixture(t)
	for _, scope := range []Scope{other, {OrgID: other.OrgID, SpaceID: s.SpaceID, SessionID: s.SessionID, PrincipalID: other.PrincipalID}} {
		if out, err := e.Receipts(ctx, scope, v.ID); err == nil || len(out) != 0 {
			t.Fatal("foreign review disclosed")
		}
		if err := e.Run(ctx, scope, v.ID); err == nil {
			t.Fatal("foreign review dispatched")
		}
	}
	p, err := e.Preview(ctx, s, r)
	if err != nil {
		t.Fatal(err)
	}
	r.Fingerprint = p.Fingerprint
	if _, err = e.Pool.Exec(ctx, `update stories set content_revision=content_revision+1 where id=$1`, r.Children[0]); err != nil {
		t.Fatal(err)
	}
	if _, err = e.Approve(ctx, s, r); err == nil {
		t.Fatal("stale review accepted")
	}
}
func TestPublicationRevocationAfterTransmissionFencesReceipt(t *testing.T) {
	e, s, r, f := fixture(t)
	v := approve(t, e, s, r)
	ctx := context.Background()
	f.after = func(Step) { f.cap.Generation = "revoked" }
	if err := e.Run(ctx, s, v.ID); err == nil {
		t.Fatal("stale result accepted")
	}
	receipts, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Unknown {
		t.Fatalf("transmitted result: %v", receipts)
	}
}

func TestPublicationReversalAndGraphRestoration(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	if err := e.Run(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	old := stepOf(t, v, "dependency", 0)
	if _, err := e.Pool.Exec(ctx, `update poker_dependencies set retired_at=now() where id=$1`, old.EdgeID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `insert into poker_dependencies(session_id,parent_id,blocker_id,dependent_id) values($1,$2,$3,$4)`, s.SessionID, r.ParentID, old.DependentID, old.BlockerID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `update stories set dependency_revision=dependency_revision+1 where id=$1`, r.ParentID); err != nil {
		t.Fatal(err)
	}
	reversed := approve(t, e, s, r)
	remove := stepOf(t, reversed, "remove-dependency", 0)
	f.fail[remove.Key] = true
	if err := e.Run(ctx, s, reversed.ID); err == nil {
		t.Fatal("reversal added before removal confirmation")
	}
	for _, step := range reversed.Steps {
		if step.Kind == "dependency" && step.BlockerID == old.DependentID && f.calls[step.Key] != 0 {
			t.Fatal("reverse edge dispatched before removal")
		}
	}
	f.fail[remove.Key] = false
	f.unknown[remove.Key] = true
	if err := e.Run(ctx, s, reversed.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[remove.Key] != 2 {
		t.Fatal("failed removal not retried")
	}
	if _, err := e.Pool.Exec(ctx, `update poker_dependencies set retired_at=now() where blocker_id=$1 and dependent_id=$2`, old.DependentID, old.BlockerID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `update poker_dependencies set retired_at=null where id=$1`, old.EdgeID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `update stories set dependency_revision=dependency_revision+1 where id=$1`, r.ParentID); err != nil {
		t.Fatal(err)
	}
	restored := approve(t, e, s, r)
	if err := e.Run(ctx, s, restored.ID); err != nil {
		t.Fatal(err)
	}
	fresh := stepOf(t, restored, "dependency", 0)
	if fresh.Key == old.Key {
		t.Fatal("restored graph reused removed receipt")
	}
}
func TestPublicationSameDestinationTypeChangeNeverRecreates(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	if err := e.Run(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	f.cap.IssueType = "Changed task"
	fresh := approve(t, e, s, r)
	if err := e.Run(ctx, s, fresh.ID); err == nil {
		t.Fatal("changed type treated as delivered")
	}
	for _, step := range fresh.Steps {
		if step.Kind == "create" && step.Key != stepOfChild(v, step.ChildID).Key {
			t.Fatal("type change recreated same child in destination")
		}
	}
}
func stepOfChild(v Review, id string) Step {
	for _, s := range v.Steps {
		if s.Kind == "create" && s.ChildID == id {
			return s
		}
	}
	return Step{}
}

func TestPublicationSuccessorWaitsForUnknownAndSupersedesOldReview(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	var estimate Step
	for _, step := range v.Steps {
		if step.Kind == "estimate" && step.ChildID == r.Children[0] {
			estimate = step
		}
	}
	if _, err := e.Pool.Exec(ctx, `update poker_publication_steps set state='unknown' where operation_key=$1`, estimate.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `update stories set estimate='5',content_revision=content_revision+1 where id=$1`, estimate.ChildID); err != nil {
		t.Fatal(err)
	}
	fresh := approve(t, e, s, r)
	if err := e.Run(ctx, s, v.ID); err == nil {
		t.Fatal("obsolete review dispatched")
	}
	if err := e.Run(ctx, s, fresh.ID); err == nil {
		t.Fatal("successor overwrote an unknown estimate")
	}
	for _, step := range fresh.Steps {
		if step.Kind == "estimate" && step.ChildID == estimate.ChildID && f.calls[step.Key] != 0 {
			t.Fatal("successor dispatched")
		}
	}
	if err := e.Verify(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.Run(ctx, s, fresh.ID); err != nil {
		t.Fatal(err)
	}

}
func TestPublicationConcurrentLeaseAndLateReceipt(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	entered := make(chan Step, 1)
	release := make(chan struct{})
	finished := make(chan error, 1)
	var blocked atomic.Bool
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	f.after = func(step Step) {
		if blocked.CompareAndSwap(false, true) {
			entered <- step
			<-release
		}
	}
	go func() { finished <- e.Run(ctx, s, v.ID) }()
	step := <-entered
	if err := e.Run(ctx, s, v.ID); err == nil {
		t.Fatal("second runner acquired active step")
	}
	if _, err := e.Pool.Exec(ctx, `update poker_publication_steps set lease_until=now()-interval '1 second' where operation_key=$1`, step.Key); err != nil {
		t.Fatal(err)
	}
	close(release)
	released = true
	if err := <-finished; err == nil {
		t.Fatal("expired worker accepted receipt")
	}
	receipts, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Unknown {
		t.Fatal(receipts[0])
	}
}
func TestPublicationDisabledAndBadMappedValues(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	e.Provider = nil
	if _, err := e.Preview(ctx, s, r); err == nil {
		t.Fatal("unconfigured provider enabled")
	}
	e.Provider = f
	f.cap.Verified = false
	if _, err := e.Preview(ctx, s, r); err == nil {
		t.Fatal("unverified provider enabled")
	}
	f.cap.Verified = true
	f.cap.Mapping["3"] = "300"
	if _, err := e.Preview(ctx, s, r); err == nil {
		t.Fatal("incorrect numeric mapping enabled")
	}
	f.cap.Mapping["3"] = "3"
	if _, err := e.Pool.Exec(ctx, `update stories set accepted_scope_revision=9 where id=$1`, r.Children[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Preview(ctx, s, r); err == nil {
		t.Fatal("stale accepted value published")
	}
}

func TestPublicationAuthorityAtEveryReadAndWrite(t *testing.T) {
	for _, change := range []string{"member", "facilitator", "guest", "org", "space"} {
		t.Run(change, func(t *testing.T) {
			e, s, r, _ := fixture(t)
			ctx := context.Background()
			v := approve(t, e, s, r)
			switch change {
			case "member":
				if _, err := e.Pool.Exec(ctx, `delete from members where space_id=$1 and user_id=$2`, s.SpaceID, s.PrincipalID); err != nil {
					t.Fatal(err)
				}
			case "facilitator":
				_, other, _, _ := fixture(t)
				if _, err := e.Pool.Exec(ctx, `update sessions set facilitator_id=$2 where id=$1`, s.SessionID, other.PrincipalID); err != nil {
					t.Fatal(err)
				}
			case "guest":
				var link string
				_, hash := store.NewToken()
				if err := e.Pool.QueryRow(ctx, `insert into session_links(session_id,created_by,token_hash,expires_at) values($1,$2,$3,now()+interval '1 hour') returning id::text`, s.SessionID, s.PrincipalID, hash).Scan(&link); err != nil {
					t.Fatal(err)
				}
				if _, err := e.Pool.Exec(ctx, `update users set link_id=$2 where id=$1`, s.PrincipalID, link); err != nil {
					t.Fatal(err)
				}
			case "org":
				_, other, _, _ := fixture(t)
				s.OrgID = other.OrgID
			case "space":
				_, other, _, _ := fixture(t)
				s.SpaceID = other.SpaceID
			}
			if _, err := e.Preview(ctx, s, r); err == nil {
				t.Fatal("unauthorized preview")
			}
			if _, err := e.Approve(ctx, s, r); err == nil {
				t.Fatal("unauthorized approval")
			}
			if out, err := e.Receipts(ctx, s, v.ID); err == nil || len(out) != 0 {
				t.Fatal("unauthorized receipt projection")
			}
			if err := e.Run(ctx, s, v.ID); err == nil {
				t.Fatal("unauthorized dispatch")
			}
			if err := e.Verify(ctx, s, v.ID); err == nil {
				t.Fatal("unauthorized reconciliation")
			}
		})
	}
}

func TestPublicationRevocationDuringReadbackPreventsWrite(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	f.onInspect = func(Step) { f.cap.Generation = "revoked" }
	if err := e.Run(ctx, s, v.ID); err == nil {
		t.Fatal("revoked during lookup dispatched")
	}
	if len(f.calls) != 0 {
		t.Fatal("write after lookup revocation")
	}
}
func TestPublicationUnconfirmedSuccessRemainsUnknown(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	create := stepOf(t, v, "create", 0)
	f.after = func(step Step) {
		if step.Key == create.Key {
			f.ambiguous[step.Key] = true
		}
	}
	if err := e.Run(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	receipts, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range receipts {
		if receipt.Key == create.Key && receipt.State != Unknown {
			t.Fatal("HTTP success claimed readback confirmation")
		}
	}
	delete(f.ambiguous, create.Key)
	f.after = nil
	if err = e.Run(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[create.Key] != 1 {
		t.Fatal("lost readback duplicated create")
	}
}

func TestPublicationNewFacilitatorCanInspectRetainedReview(t *testing.T) {
	e, s, r, _ := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	_, other, _, _ := fixture(t)
	if err := (&store.Orgs{Pool: e.Pool}).AddMember(ctx, s.OrgID, other.PrincipalID, "member"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `insert into members(space_id,user_id,role) values($1,$2,'member')`, s.SpaceID, other.PrincipalID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `update sessions set facilitator_id=$2 where id=$1`, s.SessionID, other.PrincipalID); err != nil {
		t.Fatal(err)
	}
	s.PrincipalID = other.PrincipalID
	if out, err := e.Receipts(ctx, s, v.ID); err != nil || len(out) == 0 {
		t.Fatal("current facilitator lost prior publication history", err)
	}
	if err := e.Run(ctx, s, v.ID); err == nil {
		t.Fatal("transferred facilitator reused another principal's approval")
	}
}

func TestPublicationBlankNeverClearsUnexpectedDefault(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	var blank Step
	for _, step := range v.Steps {
		if step.Kind == "estimate" && step.ChildID == r.Children[2] {
			blank = step
		}
	}
	f.nonblankDefaults = map[string]bool{blank.Key: true}
	if err := e.Run(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[blank.Key] != 0 {
		t.Fatal("blank estimate cleared provider default")
	}
	receipts, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range receipts {
		if receipt.Key == blank.Key && receipt.State != Failed {
			t.Fatal(receipt)
		}
	}
}
func TestPublicationNewReviewSupersedesUnchangedOldReview(t *testing.T) {
	e, s, r, _ := fixture(t)
	ctx := context.Background()
	old := approve(t, e, s, r)
	fresh := approve(t, e, s, r)
	if err := e.Run(ctx, s, old.ID); err == nil {
		t.Fatal("superseded unchanged review dispatched")
	}
	if err := e.Run(ctx, s, fresh.ID); err != nil {
		t.Fatal(err)
	}
}

func TestPublicationVerificationFencesChangedGeneration(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	create := stepOf(t, v, "create", 0)
	if _, err := e.Pool.Exec(ctx, `update poker_publication_steps set state='unknown' where operation_key=$1`, create.Key); err != nil {
		t.Fatal(err)
	}
	f.remote[create.Key] = "previously-created"
	f.onInspect = func(Step) { f.cap.Generation = "changed" }
	if err := e.Verify(ctx, s, v.ID); err == nil {
		t.Fatal("verification accepted stale generation")
	}
	receipts, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Unknown {
		t.Fatal("stale verification accepted receipt")
	}
}

func TestPublicationProviderConflictNeverAuthorizesOverwrite(t *testing.T) {
	e, s, r, f := fixture(t)
	ctx := context.Background()
	v := approve(t, e, s, r)
	create := stepOf(t, v, "create", 0)
	f.denied = map[string]bool{create.Key: true}
	if err := e.Run(ctx, s, v.ID); err != nil {
		t.Fatal(err)
	}
	if f.calls[create.Key] != 0 {
		t.Fatal("known readback widened provider write authority")
	}
	receipts, err := e.Receipts(ctx, s, v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if receipts[0].State != Failed {
		t.Fatal(receipts[0])
	}
}

func TestPublicationUncertainIdentityNeverAuthorizesCreate(t *testing.T) {
	for _, test := range []struct {
		name        string
		observation Observation
		lookupError bool
	}{
		{name: "unknown", observation: Observation{MutationAllowed: true}},
		{name: "error", observation: Observation{MutationAllowed: true}, lookupError: true},
		{name: "id", observation: Observation{Matches: true, MutationAllowed: true, RemoteID: "remote-existing"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			e, s, r, f := fixture(t)
			ctx := context.Background()
			v := approve(t, e, s, r)
			create := stepOfChild(v, r.Children[0])
			if create.Key == "" {
				t.Fatal("API create operation absent")
			}
			if _, err := e.Pool.Exec(ctx, `update poker_publication_steps set state='unknown' where operation_key=$1`, create.Key); err != nil {
				t.Fatal(err)
			}
			f.remote[create.Key] = "remote-existing"
			f.observations = map[string]Observation{create.Key: test.observation}
			f.ambiguous[create.Key] = test.lookupError
			for attempt := 0; attempt < 2; attempt++ {
				if err := e.Run(ctx, s, v.ID); err != nil {
					t.Fatal(err)
				}
				if f.calls[create.Key] != 0 || f.remote[create.Key] != "remote-existing" {
					t.Fatal("uncertain identity recreated existing remote child")
				}
				receipts, err := e.Receipts(ctx, s, v.ID)
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, receipt := range receipts {
					if receipt.Key == create.Key {
						found = true
						if receipt.State != Unknown || receipt.RemoteID != "" {
							t.Fatalf("unverified identity receipt: %+v", receipt)
						}
					}
					if receipt.Kind == "dependency" && receipt.BlockerID == create.ChildID && receipt.State != Waiting {
						t.Fatalf("unconfirmed blocker endpoint linked: %+v", receipt)
					}
				}
				if !found {
					t.Fatal("unknown create receipt disappeared")
				}
			}
			delete(f.observations, create.Key)
			delete(f.ambiguous, create.Key)
			if err := e.Run(ctx, s, v.ID); err != nil {
				t.Fatal(err)
			}
			if f.calls[create.Key] != 0 {
				t.Fatal("reconciliation recreated existing child")
			}
			receipts, err := e.Receipts(ctx, s, v.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, receipt := range receipts {
				if receipt.Key == create.Key && (receipt.State != Confirmed || receipt.RemoteID != "remote-existing") {
					t.Fatalf("definitive identity not retained: %+v", receipt)
				}
			}
		})
	}
}
