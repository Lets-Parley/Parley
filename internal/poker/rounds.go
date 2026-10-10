package poker

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/lets-parley/parley/internal/store"
)

var errRoundReview = errors.New("round changed or explicit review required")

type roundReview struct {
	ExpectedRoundVersion   *int64  `json:"expectedRoundVersion"`
	ExpectedCurrentStoryID *string `json:"expectedCurrentStoryId"`
}

func roundIdentity(ctx context.Context, tx pgx.Tx, sessionID string) (string, int64, error) {
	var id string
	var version int64
	err := tx.QueryRow(ctx, `select coalesce(current_story_id::text,''),poker_round_version from sessions where id=$1`, sessionID).Scan(&id, &version)
	return id, version, err
}

func checkRound(ctx context.Context, tx pgx.Tx, sess store.Session, storyID string, expected *int64) error {
	id, version, err := roundIdentity(ctx, tx, sess.ID)
	if err != nil {
		return err
	}
	var split bool
	if id != "" {
		if err := tx.QueryRow(ctx, `select parent_id is not null or split_revision>0 from stories where id=$1 and session_id=$2`, id, sess.ID).Scan(&split); err != nil {
			return err
		}
	}
	if split && (expected == nil || storyID != id) {
		return errRoundReview
	}
	if expected != nil && (*expected != version || storyID != id) {
		return errRoundReview
	}
	return nil
}

func checkReviewedRound(ctx context.Context, tx pgx.Tx, sess store.Session, review roundReview) error {
	id, version, err := roundIdentity(ctx, tx, sess.ID)
	if err != nil {
		return err
	}
	if review.ExpectedRoundVersion == nil || review.ExpectedCurrentStoryID == nil || *review.ExpectedRoundVersion != version || *review.ExpectedCurrentStoryID != id {
		return errRoundReview
	}
	return nil
}

func reviewParentSwitch(ctx context.Context, tx pgx.Tx, sess store.Session, parentID string, confirmed bool, review roundReview) error {
	id, version, err := roundIdentity(ctx, tx, sess.ID)
	if err != nil {
		return err
	}
	if id != parentID {
		return nil
	}
	var saved *int64
	if err := tx.QueryRow(ctx, `select accepted_round_version from stories where id=$1 and session_id=$2`, id, sess.ID).Scan(&saved); err != nil {
		return err
	}
	if !sess.Revealed || saved == nil || *saved != version {
		if !confirmed {
			return errRoundReview
		}
		return checkReviewedRound(ctx, tx, sess, review)
	}
	return nil
}

func clearStoryRound(ctx context.Context, tx pgx.Tx, storyID string) error {
	if _, err := tx.Exec(ctx, `delete from votes where story_id=$1`, storyID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `delete from round_voters where story_id=$1`, storyID)
	return err
}
