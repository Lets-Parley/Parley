package poker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

const storyTotalProvenance = "story-total"

var errTotalUnavailable = errors.New("split has a story without a current numeric estimate")

type parentEstimateBody struct {
	ParentID              string           `json:"parentId"`
	Answer                string           `json:"answer"`
	ExpectedTotal         string           `json:"expectedTotal"`
	ExpectedRevision      *int64           `json:"expectedRevision"`
	ExpectedSplitRevision *int64           `json:"expectedSplitRevision"`
	Children              map[string]int64 `json:"children"`
}

func answerParentEstimate(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body parentEstimateBody
	if !decode(w, r, &body) {
		return
	}
	isTotal := body.Answer == "total"
	if (!isTotal && body.Answer != "none") || body.ExpectedSplitRevision == nil || (isTotal && body.ExpectedRevision == nil) {
		http.Error(w, `{"error":"answer is total or none, with expectedSplitRevision, and expectedRevision for a total"}`, http.StatusBadRequest)
		return
	}
	err := withSplit(r, ac, func(tx pgx.Tx, sess store.Session) error {
		var parent *string
		var content, split int64
		var role string
		if err := tx.QueryRow(r.Context(), `select parent_id::text,content_revision,split_revision,planning_role from stories where id=$1 and session_id=$2 and removed_at is null`, body.ParentID, sess.ID).Scan(&parent, &content, &split, &role); err != nil {
			return err
		}
		if parent != nil {
			return errSplitShape
		}
		if split != *body.ExpectedSplitRevision || (isTotal && content != *body.ExpectedRevision) {
			return errSplitConflict
		}
		if role != "context" {
			return errNotAdopted
		}
		if !isTotal {
			if _, err := tx.Exec(r.Context(), `update stories set parent_estimate_answered_revision=split_revision where id=$1 and session_id=$2`, body.ParentID, sess.ID); err != nil {
				return err
			}
			_, err := tx.Exec(r.Context(), "update sessions set version=version+1 where id=$1", sess.ID)
			return err
		}
		tabled, _, err := roundIdentity(r.Context(), tx, sess.ID)
		if err != nil {
			return err
		}
		if tabled == body.ParentID {
			return errRoundReview
		}
		var staleChildren, activeChildren int
		if err := tx.QueryRow(r.Context(), `select count(*) filter (where ($3::jsonb->>(id::text))::bigint is distinct from content_revision),count(*)
			from stories where parent_id=$1 and session_id=$2 and removed_at is null`, body.ParentID, sess.ID, childRevisionsJSON(body.Children)).Scan(&staleChildren, &activeChildren); err != nil {
			return err
		}
		if staleChildren != 0 || activeChildren != len(body.Children) {
			return errSplitConflict
		}
		total, err := storyTotal(r.Context(), tx, sess, body.ParentID)
		if err != nil {
			return err
		}
		if total != body.ExpectedTotal {
			return errSplitConflict
		}
		if _, err := tx.Exec(r.Context(), `update stories set estimate=$3,status='estimated',accepted_scope_revision=scope_revision,accepted_round_version=null,
			estimate_provenance=$4,parent_estimate_answered_revision=split_revision,content_revision=content_revision+1 where id=$1 and session_id=$2`, body.ParentID, sess.ID, total, storyTotalProvenance); err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), "update sessions set version=version+1 where id=$1", sess.ID)
		return err
	})
	if errors.Is(err, errTotalUnavailable) {
		http.Error(w, `{"error":"a total needs every story in the split to have a current numeric estimate"}`, http.StatusConflict)
		return
	}
	if err != nil {
		writeSplitError(r, w, err)
		return
	}
	committed(w, r, ac)
}

func sessionDeck(sess store.Session) (Deck, error) {
	var cfg Config
	if err := json.Unmarshal(sess.Config, &cfg); err != nil {
		return Deck{}, fmt.Errorf("reading poker config: %w", err)
	}
	return cfg.ResolveDeck(), nil
}

func storyTotal(ctx context.Context, tx pgx.Tx, sess store.Session, parentID string) (string, error) {
	deck, err := sessionDeck(sess)
	if err != nil {
		return "", err
	}
	if deck.Ordinal {
		return "", errTotalUnavailable
	}
	rows, err := tx.Query(ctx, `select estimate,accepted_scope_revision is not distinct from scope_revision from stories
		where parent_id=$1 and session_id=$2 and removed_at is null and planning_role='planning'`, parentID, sess.ID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	total := new(big.Rat)
	counted := 0
	for rows.Next() {
		var estimate *string
		var isCurrent bool
		if err := rows.Scan(&estimate, &isCurrent); err != nil {
			return "", err
		}
		if estimate == nil || !isCurrent {
			return "", errTotalUnavailable
		}
		points, isNumeric := exactCardValue(*estimate)
		if !isNumeric {
			return "", errTotalUnavailable
		}
		total.Add(total, points)
		counted++
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if counted == 0 {
		return "", errTotalUnavailable
	}
	if total.IsInt() {
		return total.Num().String(), nil
	}
	return strings.TrimRight(strings.TrimRight(total.FloatString(6), "0"), "."), nil
}

func exactCardValue(card string) (*big.Rat, bool) {
	if card == "½" {
		return big.NewRat(1, 2), true
	}
	if _, isNumber := cardValue(card); !isNumber {
		return nil, false
	}
	return new(big.Rat).SetString(card)
}

func flagStoryTotalForReview(ctx context.Context, tx pgx.Tx, sessionID, parentID string) error {
	_, err := tx.Exec(ctx, `update stories set scope_revision=scope_revision+1 where id=$1 and session_id=$2
		and estimate_provenance=$3 and accepted_scope_revision is not distinct from scope_revision`, parentID, sessionID, storyTotalProvenance)
	return err
}
