package publication

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/poker"
)

type child struct {
	ID, Title, Notes, Role  string
	Revision, ScopeRevision int64
	Estimate                *string
	AcceptedScope           *int64
	Removed                 bool
}
type edge struct {
	ID, BlockerID, DependentID string
	Retired, Unavailable       bool
}
type snapshot struct {
	Scope                                  Scope
	Capability                             Capability
	ParentID, Title, Notes, Role, Coverage string
	Revision, SplitRevision, GraphRevision int64
	Config                                 json.RawMessage
	Children                               []child
	Edges                                  []edge
	Selected                               []string
}

func digest(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (e *Engine) authorize(ctx context.Context, tx pgx.Tx, s Scope, active bool) error {
	var ok bool
	err := tx.QueryRow(ctx, `select true from sessions s
 join spaces sp on sp.id=s.space_id join session_kinds k on k.kind=s.kind
 join members m on m.space_id=sp.id and m.user_id=$4
 join org_members om on om.org_id=sp.org_id and om.user_id=m.user_id
 join users u on u.id=m.user_id
 where s.id=$3 and s.space_id=$2 and sp.org_id=$1 and s.kind='poker'
 and s.facilitator_id=$4 and om.revoked_at is null and u.link_id is null
 and (not $5 or (s.ended_at is null and k.retired_at is null))
 for update of s for share of sp,k,m,om,u`, s.OrgID, s.SpaceID, s.SessionID, s.PrincipalID, active).Scan(&ok)
	if err == pgx.ErrNoRows {
		return ErrPaused
	}
	if err != nil {
		return fmt.Errorf("checking publication access: %w", err)
	}
	return nil
}
func (e *Engine) capture(ctx context.Context, tx pgx.Tx, s Scope, r Request) (snapshot, error) {
	snap := snapshot{Scope: s, ParentID: r.ParentID, Selected: slices.Clone(r.Children)}
	if len(snap.Selected) == 0 || len(snap.Selected) > 10 {
		return snap, ErrPaused
	}
	slices.Sort(snap.Selected)
	if len(slices.Compact(slices.Clone(snap.Selected))) != len(snap.Selected) {
		return snap, ErrPaused
	}
	if err := e.authorize(ctx, tx, s, true); err != nil {
		return snap, err
	}
	if e.Provider == nil {
		return snap, ErrPaused
	}
	cap, err := e.Provider.Capability(ctx, s)
	if err != nil || !cap.Verified || cap.Generation == "" || cap.Destination == "" || cap.IssueType == "" || cap.ParentID == "" || cap.ParentDisposition != "excluded-from-counting" || cap.FieldID == "" {
		return snap, ErrPaused
	}
	for _, v := range []string{cap.Generation, cap.Destination, cap.IssueType, cap.ParentID, cap.FieldID} {
		if len(v) > 256 || strings.ContainsAny(v, "\r\n") {
			return snap, ErrPaused
		}
	}
	if len(cap.Mapping) > 15 {
		return snap, ErrPaused
	}
	snap.Capability = cap
	err = tx.QueryRow(ctx, `select p.title,p.notes,p.planning_role,coalesce(p.coverage,''),p.content_revision,p.split_revision,p.dependency_revision,s.config from stories p join sessions s on s.id=p.session_id where p.id=$1 and p.session_id=$2 and p.parent_id is null and p.removed_at is null`, r.ParentID, s.SessionID).Scan(&snap.Title, &snap.Notes, &snap.Role, &snap.Coverage, &snap.Revision, &snap.SplitRevision, &snap.GraphRevision, &snap.Config)
	if err == pgx.ErrNoRows {
		return snap, ErrPaused
	}
	if err != nil {
		return snap, fmt.Errorf("reading publication parent: %w", err)
	}
	if snap.Role != "context" || snap.Coverage == "needs-review" {
		return snap, ErrPaused
	}
	rows, err := tx.Query(ctx, `select id::text,title,notes,planning_role,content_revision,scope_revision,estimate,accepted_scope_revision,removed_at is not null from stories where parent_id=$1 and session_id=$2 order by id`, r.ParentID, s.SessionID)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var c child
		if err = rows.Scan(&c.ID, &c.Title, &c.Notes, &c.Role, &c.Revision, &c.ScopeRevision, &c.Estimate, &c.AcceptedScope, &c.Removed); err != nil {
			rows.Close()
			return snap, err
		}
		snap.Children = append(snap.Children, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return snap, err
	}
	found := 0
	for _, c := range snap.Children {
		if slices.Contains(snap.Selected, c.ID) {
			found++
			if c.Removed || c.Role != "planning" || (c.Estimate != nil && (c.AcceptedScope == nil || *c.AcceptedScope != c.ScopeRevision)) {
				return snap, ErrPaused
			}
		}
	}
	if found != len(snap.Selected) {
		return snap, ErrPaused
	}
	rows, err = tx.Query(ctx, `select d.id::text,d.blocker_id::text,d.dependent_id::text,d.retired_at is not null,(d.review_needed or a.removed_at is not null or b.removed_at is not null) from poker_dependencies d join stories a on a.id=d.blocker_id join stories b on b.id=d.dependent_id where d.session_id=$2 and d.parent_id=$1 order by d.id`, r.ParentID, s.SessionID)
	if err != nil {
		return snap, err
	}
	for rows.Next() {
		var v edge
		if err = rows.Scan(&v.ID, &v.BlockerID, &v.DependentID, &v.Retired, &v.Unavailable); err != nil {
			rows.Close()
			return snap, err
		}
		snap.Edges = append(snap.Edges, v)
	}
	err = rows.Err()
	rows.Close()
	return snap, err
}
func createKey(s snapshot, id string) string {
	return digest([]string{s.Scope.OrgID, s.Scope.SpaceID, s.Scope.SessionID, s.ParentID, s.Capability.Destination, "create", id})
}
func stepsFor(s snapshot) ([]Step, error) {
	var cfg poker.Config
	if err := json.Unmarshal(s.Config, &cfg); err != nil {
		return nil, err
	}
	deck := cfg.ResolveDeck()
	var steps []Step
	for _, c := range s.Children {
		if slices.Contains(s.Selected, c.ID) {
			steps = append(steps, Step{Key: createKey(s, c.ID), Kind: "create", ChildID: c.ID, Title: c.Title, Notes: c.Notes, Body: c.Notes + "\n\n<!-- parley-publication:" + createKey(s, c.ID) + " -->"})
		}
	}
	// Removals precede all additions, so reversing a pair cannot race its removal.
	for _, v := range s.Edges {
		if v.Retired {
			key := digest([]string{s.Scope.OrgID, s.Scope.SessionID, s.Capability.Destination, "dependency", v.ID})
			steps = append(steps, Step{Key: digest([]any{key, "remove", s.GraphRevision}), PairKey: key, Kind: "remove-dependency", EdgeID: v.ID, BlockerID: v.BlockerID, DependentID: v.DependentID})
		}
	}
	for _, c := range s.Children {
		if slices.Contains(s.Selected, c.ID) {
			steps = append(steps, Step{Key: digest([]string{createKey(s, c.ID), "parent", s.Capability.ParentID}), Kind: "parent", ChildID: c.ID})
		}
	}
	for _, v := range s.Edges {
		if !v.Retired {
			steps = append(steps, Step{Key: digest([]any{s.Scope.OrgID, s.Scope.SessionID, s.Capability.Destination, "dependency", v.ID, s.GraphRevision}), PairKey: digest([]string{s.Scope.OrgID, s.Scope.SessionID, s.Capability.Destination, "dependency", v.ID}), Kind: "dependency", EdgeID: v.ID, BlockerID: v.BlockerID, DependentID: v.DependentID, Waiting: v.Unavailable || !slices.Contains(s.Selected, v.BlockerID) || !slices.Contains(s.Selected, v.DependentID)})
		}
	}
	for _, c := range s.Children {
		if slices.Contains(s.Selected, c.ID) {
			value := ""
			if c.Estimate != nil {
				if !deck.Has(*c.Estimate) || *c.Estimate == "?" || *c.Estimate == "coffee" {
					return nil, ErrPaused
				}
				var ok bool
				value, ok = s.Capability.Mapping[*c.Estimate]
				if !ok || value == "" || len(value) > 256 {
					return nil, ErrPaused
				}
				if !deck.Ordinal {
					// Numeric cards use the core deck's accepted labels; the host map must be exact.
					expected := *c.Estimate
					if expected == "½" {
						expected = "0.5"
					}
					if value != expected {
						return nil, ErrPaused
					}
				}
			}
			if s.Capability.ProjectID != "" {
				steps = append(steps, Step{Key: digest([]string{createKey(s, c.ID), "project", s.Capability.ProjectID}), Kind: "project", ChildID: c.ID})
			}
			steps = append(steps, Step{Key: digest([]any{createKey(s, c.ID), "estimate", s.Capability.FieldID, c.AcceptedScope, c.Estimate, value}), Kind: "estimate", ChildID: c.ID, Value: value})
		}
	}
	for i := range steps {
		steps[i].Binding = s.Capability
		switch steps[i].Kind {
		case "create":
			steps[i].TargetKey = steps[i].Key
		case "parent":
			steps[i].TargetKey = digest([]string{createKey(s, steps[i].ChildID), "parent"})
		case "project":
			steps[i].TargetKey = steps[i].Key
		case "estimate":
			steps[i].TargetKey = digest([]string{createKey(s, steps[i].ChildID), "estimate", s.Capability.FieldID})
		default:
			steps[i].TargetKey = steps[i].PairKey
		}
	}
	return steps, nil
}
func (e *Engine) Preview(ctx context.Context, s Scope, r Request) (Review, error) {
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return Review{}, err
	}
	defer tx.Rollback(ctx)
	snap, err := e.capture(ctx, tx, s, r)
	if err != nil {
		return Review{}, err
	}
	steps, err := stepsFor(snap)
	if err != nil {
		return Review{}, err
	}
	v := Review{Fingerprint: digest(snap), Binding: snap.Capability, Steps: steps}
	for _, step := range steps {
		receipt := Receipt{Key: step.Key, Kind: step.Kind, ChildID: step.ChildID, BlockerID: step.BlockerID, DependentID: step.DependentID, State: Local}
		err := tx.QueryRow(ctx, `select state,coalesce(remote_id,''),attempts from poker_publication_steps where operation_key=$1 and session_id=$2`, step.Key, s.SessionID).Scan(&receipt.State, &receipt.RemoteID, &receipt.Attempts)
		if err != nil && err != pgx.ErrNoRows {
			return Review{}, err
		}
		if err == pgx.ErrNoRows && step.Waiting {
			receipt.State = Waiting
		}
		v.Existing = append(v.Existing, receipt)
	}
	return v, nil
}
func (e *Engine) Approve(ctx context.Context, s Scope, r Request) (Review, error) {
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return Review{}, err
	}
	defer tx.Rollback(ctx)
	snap, err := e.capture(ctx, tx, s, r)
	if err != nil {
		return Review{}, err
	}
	fingerprint := digest(snap)
	if r.Fingerprint == "" || r.Fingerprint != fingerprint {
		return Review{}, ErrPaused
	}
	steps, err := stepsFor(snap)
	if err != nil {
		return Review{}, err
	}
	r.Children = snap.Selected
	request, _ := json.Marshal(r)
	rawSteps, _ := json.Marshal(steps)
	v := Review{Fingerprint: fingerprint, Binding: snap.Capability, Steps: steps}
	if err = tx.QueryRow(ctx, `insert into poker_publication_reviews(session_id,parent_id,principal_id,fingerprint,request,steps) values($1,$2,$3,$4,$5,$6) returning id::text`, s.SessionID, r.ParentID, s.PrincipalID, fingerprint, request, rawSteps).Scan(&v.ID); err != nil {
		return Review{}, fmt.Errorf("recording publication review: %w", err)
	}
	for _, step := range steps {
		state := Pending
		if step.Waiting {
			state = Waiting
		}
		if _, err = tx.Exec(ctx, `insert into poker_publication_steps(operation_key,session_id,parent_id,kind,state,target_key,issue_type) values($1,$2,$3,$4,$5,$6,$7) on conflict(operation_key) do nothing`, step.Key, s.SessionID, r.ParentID, step.Kind, state, step.TargetKey, snap.Capability.IssueType); err != nil {
			return Review{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Review{}, err
	}
	return v, nil
}
func (e *Engine) readReview(ctx context.Context, tx pgx.Tx, s Scope, id string) (Request, Review, error) {
	var r Request
	v := Review{ID: id}
	var raw, steps []byte
	err := tx.QueryRow(ctx, `select request,steps,fingerprint,principal_id::text from poker_publication_reviews where id=$1 and session_id=$2`, id, s.SessionID).Scan(&raw, &steps, &v.Fingerprint, &v.PrincipalID)
	if err == pgx.ErrNoRows {
		return r, v, ErrPaused
	}
	if err != nil {
		return r, v, err
	}
	if err = json.Unmarshal(raw, &r); err != nil {
		return r, v, err
	}
	err = json.Unmarshal(steps, &v.Steps)
	return r, v, err
}
func (e *Engine) current(ctx context.Context, tx pgx.Tx, s Scope, id string) (snapshot, Review, error) {
	r, v, err := e.readReview(ctx, tx, s, id)
	if err != nil {
		return snapshot{}, v, err
	}
	if v.PrincipalID != s.PrincipalID {
		return snapshot{}, v, ErrPaused
	}
	snap, err := e.capture(ctx, tx, s, r)
	if err != nil {
		return snap, v, err
	}
	var newer bool
	if err = tx.QueryRow(ctx, `select exists(select 1 from poker_publication_reviews newer join poker_publication_reviews old on old.id=$1 where newer.session_id=old.session_id and newer.parent_id=old.parent_id and newer.revision>old.revision)`, id).Scan(&newer); err != nil {
		return snap, v, err
	}
	if newer {
		return snap, v, ErrPaused
	}
	if digest(snap) != v.Fingerprint {
		return snap, v, ErrPaused
	}
	return snap, v, nil
}
func (e *Engine) Receipts(ctx context.Context, s Scope, id string) ([]Receipt, error) {
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = e.authorize(ctx, tx, s, false); err != nil {
		return nil, err
	}
	_, v, err := e.readReview(ctx, tx, s, id)
	if err != nil {
		return nil, err
	}
	if v.PrincipalID != s.PrincipalID {
		return nil, ErrPaused
	}
	var out []Receipt
	for _, step := range v.Steps {
		receipt := Receipt{Key: step.Key, Kind: step.Kind, ChildID: step.ChildID, EdgeID: step.EdgeID, BlockerID: step.BlockerID, DependentID: step.DependentID}
		if err = tx.QueryRow(ctx, `select state,coalesce(remote_id,''),attempts from poker_publication_steps where operation_key=$1 and session_id=$2`, step.Key, s.SessionID).Scan(&receipt.State, &receipt.RemoteID, &receipt.Attempts); err != nil {
			return nil, err
		}
		out = append(out, receipt)
	}
	return out, nil
}
