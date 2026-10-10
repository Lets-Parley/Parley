package poker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

type dependencyPair struct {
	BlockerID   string `json:"blockerId"`
	DependentID string `json:"dependentId"`
}
type WireDependency struct {
	ID          string     `json:"id"`
	ParentID    string     `json:"parentId"`
	BlockerID   string     `json:"blockerId"`
	DependentID string     `json:"dependentId"`
	ReviewState string     `json:"reviewState"`
	RetiredAt   *time.Time `json:"retiredAt"`
}
type dependencyChild struct {
	title    string
	revision int64
	removed  bool
}
type dependencyCycle struct{ chain []string }

func (e *dependencyCycle) Error() string {
	return "dependency cycle: " + strings.Join(e.chain, " → ")
}

var errDependencyEndpoint = errors.New("dependency endpoint is not an active sibling")
var errDependencyDuplicate = errors.New("duplicate dependency pair")

func validateDependencies(edges []dependencyPair, children map[string]dependencyChild) error {
	graph := map[string][]string{}
	seen := map[dependencyPair]bool{}
	for _, e := range edges {
		a, okA := children[e.BlockerID]
		b, okB := children[e.DependentID]
		if !okA || !okB || a.removed || b.removed {
			return errDependencyEndpoint
		}
		if seen[e] {
			return errDependencyDuplicate
		}
		seen[e] = true
		graph[e.BlockerID] = append(graph[e.BlockerID], e.DependentID)
	}
	colors := map[string]int{}
	stack := []string{}
	var visit func(string) error
	visit = func(id string) error {
		if colors[id] == 1 {
			start := 0
			for stack[start] != id {
				start++
			}
			chain := []string{}
			for _, n := range append(append([]string{}, stack[start:]...), id) {
				chain = append(chain, children[n].title)
			}
			return &dependencyCycle{chain: chain}
		}
		if colors[id] == 2 {
			return nil
		}
		colors[id] = 1
		stack = append(stack, id)
		for _, n := range graph[id] {
			if err := visit(n); err != nil {
				return err
			}
		}
		stack = stack[:len(stack)-1]
		colors[id] = 2
		return nil
	}
	for _, e := range edges {
		if err := visit(e.BlockerID); err != nil {
			return err
		}
	}
	return nil
}

func dependencyChildren(ctx context.Context, tx pgx.Tx, sessionID, parentID string) (map[string]dependencyChild, error) {
	rows, err := tx.Query(ctx, `select id::text,title,content_revision,removed_at is not null from stories where session_id=$1 and parent_id=$2`, sessionID, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	children := map[string]dependencyChild{}
	for rows.Next() {
		var id string
		var child dependencyChild
		if err := rows.Scan(&id, &child.title, &child.revision, &child.removed); err != nil {
			return nil, err
		}
		children[id] = child
	}
	return children, rows.Err()
}

func saveDependencies(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var b struct {
		ParentID                   string           `json:"parentId"`
		ExpectedDependencyRevision *int64           `json:"expectedDependencyRevision"`
		ExpectedRevision           *int64           `json:"expectedRevision"`
		Children                   map[string]int64 `json:"children"`
		Edges                      []dependencyPair `json:"edges"`
		RetireIDs                  []string         `json:"retireIds"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.ExpectedDependencyRevision == nil || b.ExpectedRevision == nil || b.Children == nil || b.Edges == nil || len(b.Edges) > maxRetainedChildren*(maxRetainedChildren-1) || len(b.RetireIDs) > maxRetainedChildren*(maxRetainedChildren-1) {
		http.Error(w, `{"error":"review graph and content revisions and provide the whole proposed edges array"}`, http.StatusBadRequest)
		return
	}
	err := withSplit(r, ac, func(tx pgx.Tx, sess store.Session) error {
		var revision, content int64
		if err := tx.QueryRow(r.Context(), `select dependency_revision,content_revision from stories where id=$1 and session_id=$2 and parent_id is null and removed_at is null`, b.ParentID, sess.ID).Scan(&revision, &content); err != nil {
			return err
		}
		if revision != *b.ExpectedDependencyRevision || content != *b.ExpectedRevision {
			return errSplitConflict
		}
		children, err := dependencyChildren(r.Context(), tx, sess.ID, b.ParentID)
		if err != nil {
			return err
		}
		if len(children) != len(b.Children) {
			return errSplitConflict
		}
		for id, c := range children {
			if rev, ok := b.Children[id]; !ok || rev != c.revision {
				return errSplitConflict
			}
		}
		if err := validateDependencies(b.Edges, children); err != nil {
			return err
		}
		// Missing endpoints remain unresolved unless explicitly retired by id.
		if _, err := tx.Exec(r.Context(), `update poker_dependencies d set retired_at=coalesce(retired_at,now()) where parent_id=$1 and not review_needed and exists(select 1 from stories a,stories b where a.id=d.blocker_id and b.id=d.dependent_id and a.removed_at is null and b.removed_at is null)`, b.ParentID); err != nil {
			return err
		}
		for _, id := range b.RetireIDs {
			tag, err := tx.Exec(r.Context(), `update poker_dependencies set retired_at=coalesce(retired_at,now()) where id::text=$1 and parent_id=$2`, id, b.ParentID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() != 1 {
				return errDependencyEndpoint
			}
		}
		for _, e := range b.Edges {
			if _, err := tx.Exec(r.Context(), `insert into poker_dependencies(session_id,parent_id,blocker_id,dependent_id) values($1,$2,$3,$4) on conflict(parent_id,blocker_id,dependent_id) do update set retired_at=null,review_needed=false`, sess.ID, b.ParentID, e.BlockerID, e.DependentID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(r.Context(), `update stories set dependency_revision=dependency_revision+1 where id=$1`, b.ParentID); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `update sessions set version=version+1 where id=$1`, sess.ID)
		return err
	})
	if err != nil {
		writeDependencyError(w, r, err)
		return
	}
	committed(w, r, ac)
}

func writeDependencyError(w http.ResponseWriter, r *http.Request, err error) {
	var cycle *dependencyCycle
	switch {
	case errors.As(err, &cycle):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{"error": cycle.Error(), "cycle": cycle.chain})
	case errors.Is(err, errDependencyEndpoint), errors.Is(err, errDependencyDuplicate):
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusConflict)
	default:
		writeSplitError(r, w, err)
	}
}

func changeDependencyEndpoints(ctx context.Context, tx pgx.Tx, sessionID, parentID, storyID string, remove bool, expected *int64, acknowledged []string) error {
	var revision int64
	if err := tx.QueryRow(ctx, `select dependency_revision from stories where id=$1`, parentID).Scan(&revision); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `select id::text,blocker_id::text,dependent_id::text,review_needed from poker_dependencies where parent_id=$1 and retired_at is null order by id`, parentID)
	if err != nil {
		return err
	}
	affected := map[string]bool{}
	edges := []dependencyPair{}
	affectedPairs := []dependencyPair{}
	for rows.Next() {
		var id string
		var pair dependencyPair
		var review bool
		if err := rows.Scan(&id, &pair.BlockerID, &pair.DependentID, &review); err != nil {
			rows.Close()
			return err
		}
		if pair.BlockerID == storyID || pair.DependentID == storyID {
			affected[id] = true
			affectedPairs = append(affectedPairs, pair)
		} else if !review {
			edges = append(edges, pair)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if (len(affected) > 0 && expected == nil) || (expected != nil && *expected != revision) {
		return errSplitConflict
	}
	if remove && len(affected) > 0 {
		if len(acknowledged) != len(affected) {
			return errSplitConflict
		}
		for _, id := range acknowledged {
			if !affected[id] {
				return errSplitConflict
			}
			delete(affected, id)
		}
	}
	if !remove && len(affected) > 0 {
		children, err := dependencyChildren(ctx, tx, sessionID, parentID)
		if err != nil {
			return err
		}
		child := children[storyID]
		child.removed = false
		children[storyID] = child
		// Only available endpoints may re-enter the graph. Unsafe links retain
		// their identities and need explicit review rather than disappearing.
		available := []dependencyPair{}
		for _, e := range append(edges, affectedPairs...) {
			if !children[e.BlockerID].removed && !children[e.DependentID].removed {
				available = append(available, e)
			}
		}
		review := validateDependencies(available, children) != nil
		if _, err := tx.Exec(ctx, `update poker_dependencies set review_needed=$3 where parent_id=$1 and retired_at is null and (blocker_id=$2 or dependent_id=$2)`, parentID, storyID, review); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `update stories set dependency_revision=dependency_revision+1 where id=$1`, parentID)
	return err
}
