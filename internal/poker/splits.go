package poker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

const maxRetainedChildren = 10
const minAdoptedChildren = 2

var (
	errSplitConflict = errors.New("split revision or content changed")
	errSplitShape    = errors.New("invalid split shape")
	errChildLimit    = errors.New("child limit reached")
	errSplitMinimum  = errors.New("adopted split needs two children")
	errNotPlanning   = errors.New("story is not a planning unit")
	errSplitAccess   = errors.New("split access lost")
	operationName    = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
)

// withSplit rechecks membership as well as facilitation after acquiring the
// session lock; request middleware alone can observe authority before a revoke.
func withSplit(r *http.Request, ac session.ActionCtx, fn func(pgx.Tx, store.Session) error) error {
	return (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, true, func(tx pgx.Tx, sess store.Session) error {
		if err := checkSplitMembership(r.Context(), tx, sess, ac.UserID); err != nil {
			return err
		}
		return fn(tx, sess)
	})
}

func checkSplitMembership(ctx context.Context, tx pgx.Tx, sess store.Session, userID string) error {
	var allowed bool
	err := tx.QueryRow(ctx, `select true from members m join spaces sp on sp.id=m.space_id
			join org_members om on om.org_id=sp.org_id and om.user_id=m.user_id
			join users u on u.id=m.user_id
			where m.space_id=$1 and m.user_id=$2 and om.revoked_at is null and u.link_id is null
			for share of m, om, u`, sess.SpaceID, userID).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return errSplitAccess
	}
	if err != nil {
		return err
	}
	if !allowed {
		return errSplitAccess
	}
	return nil
}

func writeSplitError(r *http.Request, w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errStoryNotInSession), errors.Is(err, errSplitAccess):
		http.Error(w, `{"error":"no such story"}`, http.StatusNotFound)
	case errors.Is(err, errSplitConflict):
		http.Error(w, `{"error":"story or split changed; review latest and your input before saving"}`, http.StatusConflict)
	case errors.Is(err, errSplitShape):
		http.Error(w, `{"error":"only a retained top-level story can have children"}`, http.StatusConflict)
	case errors.Is(err, errChildLimit):
		http.Error(w, `{"error":"a split can retain at most 10 children, including removed children"}`, http.StatusConflict)
	case errors.Is(err, errSplitMinimum):
		http.Error(w, `{"error":"an adopted split must retain at least two planning children"}`, http.StatusConflict)
	case errors.Is(err, errNotPlanning):
		http.Error(w, `{"error":"this story is not an active planning unit"}`, http.StatusConflict)
	default:
		writeMutationError(r.Context(), w, err, "could not save split")
	}
}

func bumpSplit(ctx context.Context, tx pgx.Tx, sessionID, parentID string) error {
	if _, err := tx.Exec(ctx, "update stories set split_revision=split_revision+1 where id=$1 and session_id=$2", parentID, sessionID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "update sessions set version=version+1 where id=$1", sessionID)
	return err
}

type childBody struct {
	ParentID              string `json:"parentId"`
	Title                 string `json:"title"`
	Notes                 string `json:"notes"`
	Ref                   string `json:"ref"`
	OperationID           string `json:"operationId"`
	ExpectedSplitRevision *int64 `json:"expectedSplitRevision"`
}

func addChild(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var b childBody
	if !decode(w, r, &b) {
		return
	}
	b.Title = strings.TrimSpace(b.Title)
	b.Ref = strings.TrimSpace(b.Ref)
	if b.Title == "" || !operationName.MatchString(b.OperationID) || b.ExpectedSplitRevision == nil || *b.ExpectedSplitRevision < 0 {
		http.Error(w, `{"error":"a child needs a title, operationId and expectedSplitRevision"}`, http.StatusBadRequest)
		return
	}
	if msg := storyIdentityError(b.Title, b.Ref); msg != "" {
		http.Error(w, `{"error":"`+msg+`"}`, http.StatusBadRequest)
		return
	}
	if utf8.RuneCountInString(b.Notes) > 2000 {
		http.Error(w, `{"error":"notes can be at most 2000 characters"}`, http.StatusBadRequest)
		return
	}
	payload, _ := json.Marshal(struct {
		ParentID string `json:"parentId"`
		Title    string `json:"title"`
		Notes    string `json:"notes"`
		Ref      string `json:"ref"`
	}{b.ParentID, b.Title, b.Notes, b.Ref})
	var id string
	var revision, splitRevision int64
	replayed := false
	err := withSplit(r, ac, func(tx pgx.Tx, sess store.Session) error {
		// Replay precedes revision and quota checks, because an acknowledged
		// creation has already consumed both even if its response was lost.
		var same bool
		err := tx.QueryRow(r.Context(), `select id::text,content_revision,creation_payload=$3::jsonb from stories where session_id=$1 and creation_operation=$2`, sess.ID, b.OperationID, string(payload)).Scan(&id, &revision, &same)
		if err == nil {
			if !same {
				return errSplitConflict
			}
			replayed = true
			return tx.QueryRow(r.Context(), "select split_revision from stories where id=$1 and session_id=$2", b.ParentID, sess.ID).Scan(&splitRevision)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var parent *string
		var removed bool
		if err := tx.QueryRow(r.Context(), `select parent_id::text,removed_at is not null,split_revision from stories where id=$1 and session_id=$2`, b.ParentID, sess.ID).Scan(&parent, &removed, &splitRevision); err != nil {
			return err
		}
		if parent != nil || removed {
			return errSplitShape
		}
		if splitRevision != *b.ExpectedSplitRevision {
			return errSplitConflict
		}
		var children, total int
		if err := tx.QueryRow(r.Context(), `select count(*) filter (where parent_id=$2),count(*) from stories where session_id=$1`, sess.ID, b.ParentID).Scan(&children, &total); err != nil {
			return err
		}
		if children >= maxRetainedChildren {
			return errChildLimit
		}
		if ac.StoryLimit > 0 && total >= ac.StoryLimit {
			return store.ErrQuotaExceeded
		}
		if err := tx.QueryRow(r.Context(), `insert into stories(session_id,parent_id,title,notes,ref,position,planning_role,creation_operation,creation_payload)
			values($1,$2,$3,$4,$5,(select coalesce(max(position),0)+1 from stories where session_id=$1),'proposed',$6,$7::jsonb) returning id::text`, sess.ID, b.ParentID, b.Title, b.Notes, b.Ref, b.OperationID, string(payload)).Scan(&id); err != nil {
			return err
		}
		splitRevision++
		return bumpSplit(r.Context(), tx, sess.ID, b.ParentID)
	})
	if err != nil {
		writeSplitError(r, w, err)
		return
	}
	if !replayed {
		ac.Broadcast(r.Context(), ac.Session.ID)
	}
	w.Header().Set("Content-Type", "application/json")
	status := http.StatusCreated
	if replayed {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"storyId": id, "contentRevision": revision, "splitRevision": splitRevision})
}

type adoptionBody struct {
	roundReview
	SwitchToChildren      bool             `json:"switchToChildren"`
	ParentID              string           `json:"parentId"`
	ExpectedSplitRevision *int64           `json:"expectedSplitRevision"`
	ExpectedRevision      *int64           `json:"expectedRevision"`
	Children              map[string]int64 `json:"children"`
	Coverage              string           `json:"coverage"`
	RemainderID           string           `json:"remainderId"`
}

func adoptSplit(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var b adoptionBody
	if !decode(w, r, &b) {
		return
	}
	if b.ExpectedRevision == nil || b.ExpectedSplitRevision == nil || (b.Coverage != "full" && b.Coverage != "remainder") || (b.Coverage == "remainder") != (b.RemainderID != "") {
		http.Error(w, `{"error":"review coverage and name a remainder child when scope remains"}`, http.StatusBadRequest)
		return
	}
	err := withSplit(r, ac, func(tx pgx.Tx, sess store.Session) error {
		var parent *string
		var content, split int64
		if err := tx.QueryRow(r.Context(), `select parent_id::text,content_revision,split_revision from stories where id=$1 and session_id=$2 and removed_at is null`, b.ParentID, sess.ID).Scan(&parent, &content, &split); err != nil {
			return err
		}
		if parent != nil {
			return errSplitShape
		}
		if err := reviewParentSwitch(r.Context(), tx, sess, b.ParentID, b.SwitchToChildren, b.roundReview); err != nil {
			return err
		}
		if content != *b.ExpectedRevision || split != *b.ExpectedSplitRevision {
			return errSplitConflict
		}
		rows, err := tx.Query(r.Context(), `select id::text,content_revision from stories where parent_id=$1 and session_id=$2 and removed_at is null`, b.ParentID, sess.ID)
		if err != nil {
			return err
		}
		count := 0
		remainderFound := b.RemainderID == ""
		for rows.Next() {
			var id string
			var rev int64
			if err := rows.Scan(&id, &rev); err != nil {
				rows.Close()
				return err
			}
			count++
			if expected, ok := b.Children[id]; !ok || expected != rev {
				rows.Close()
				return errSplitConflict
			}
			if id == b.RemainderID {
				remainderFound = true
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if count < minAdoptedChildren {
			return errSplitMinimum
		}
		if count != len(b.Children) || !remainderFound {
			return errSplitConflict
		}
		if _, err := tx.Exec(r.Context(), `update stories set planning_role='planning',is_remainder=(id::text=$3),content_revision=content_revision+1 where parent_id=$1 and session_id=$2 and removed_at is null`, b.ParentID, sess.ID, b.RemainderID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `update stories set planning_role='context',coverage=$3,content_revision=content_revision+1 where id=$1 and session_id=$2`, b.ParentID, sess.ID, b.Coverage); err != nil {
			return err
		}
		// Adoption ends selection of the parent without touching its votes or
		// accepted estimate, and never implicitly selects a child.
		if _, err := tx.Exec(r.Context(), `update sessions set current_story_id=null,revealed=false,poker_round_version=poker_round_version+1 where id=$1 and current_story_id=$2`, sess.ID, b.ParentID); err != nil {
			return err
		}
		return bumpSplit(r.Context(), tx, sess.ID, b.ParentID)
	})
	if err != nil {
		writeSplitError(r, w, err)
		return
	}
	committed(w, r, ac)
}

type removalBody struct {
	ExpectedDependencyRevision *int64   `json:"expectedDependencyRevision"`
	AffectedDependencies       []string `json:"affectedDependencies"`
	StoryID                    string   `json:"storyId"`
	ExpectedRevision           *int64   `json:"expectedRevision"`
	ExpectedSplitRevision      *int64   `json:"expectedSplitRevision"`
}

func removeChild(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	setChildRemoved(w, r, ac, true)
}
func restoreChild(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	setChildRemoved(w, r, ac, false)
}

func setChildRemoved(w http.ResponseWriter, r *http.Request, ac session.ActionCtx, remove bool) {
	var b removalBody
	if !decode(w, r, &b) {
		return
	}
	if b.ExpectedRevision == nil || b.ExpectedSplitRevision == nil {
		http.Error(w, `{"error":"expectedRevision and expectedSplitRevision are required"}`, http.StatusBadRequest)
		return
	}
	err := withSplit(r, ac, func(tx pgx.Tx, sess store.Session) error {
		var parent *string
		var rev, split int64
		var role string
		var removed, remainder bool
		if err := tx.QueryRow(r.Context(), `select parent_id::text,content_revision,planning_role,removed_at is not null,is_remainder from stories where id=$1 and session_id=$2`, b.StoryID, sess.ID).Scan(&parent, &rev, &role, &removed, &remainder); err != nil {
			return err
		}
		if parent == nil {
			return errSplitShape
		}
		if err := tx.QueryRow(r.Context(), `select split_revision from stories where id=$1 and session_id=$2 and removed_at is null`, *parent, sess.ID).Scan(&split); err != nil {
			return err
		}
		if rev != *b.ExpectedRevision || split != *b.ExpectedSplitRevision || removed == remove {
			return errSplitConflict
		}
		if remove && role == "planning" {
			var count int
			if err := tx.QueryRow(r.Context(), `select count(*) from stories where parent_id=$1 and session_id=$2 and planning_role='planning' and removed_at is null`, *parent, sess.ID).Scan(&count); err != nil {
				return err
			}
			if count <= minAdoptedChildren || remainder {
				return errSplitMinimum
			}
		}
		if err := changeDependencyEndpoints(r.Context(), tx, sess.ID, *parent, b.StoryID, remove, b.ExpectedDependencyRevision, b.AffectedDependencies); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `update stories set removed_at=case when $3 then now() else null end,content_revision=content_revision+1 where id=$1 and session_id=$2`, b.StoryID, sess.ID, remove); err != nil {
			return err
		}
		if role == "planning" {
			if _, err := tx.Exec(r.Context(), `update stories set coverage='needs-review',content_revision=content_revision+1 where id=$1 and session_id=$2`, *parent, sess.ID); err != nil {
				return err
			}
		}
		if remove {
			if _, err := tx.Exec(r.Context(), `update sessions set current_story_id=null,revealed=false,poker_round_version=poker_round_version+1 where id=$1 and current_story_id=$2`, sess.ID, b.StoryID); err != nil {
				return err
			}
		}
		return bumpSplit(r.Context(), tx, sess.ID, *parent)
	})
	if err != nil {
		writeSplitError(r, w, err)
		return
	}
	committed(w, r, ac)
}
