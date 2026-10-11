package publication

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Run advances each independent approved step once. It never retries a provider
// call inside a run; another run must recheck approval and reconcile first.
func (e *Engine) Run(ctx context.Context, s Scope, id string) error {
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	_, review, err := e.current(ctx, tx, s, id)
	tx.Rollback(ctx)
	if err != nil {
		return err
	}
	for _, step := range review.Steps {
		complete, err := e.advance(ctx, s, id, step)
		if err != nil {
			return err
		}
		if step.Kind == "remove-dependency" && !complete {
			return ErrPaused
		}
	}
	return nil
}
func (e *Engine) endpoint(ctx context.Context, tx pgx.Tx, snap snapshot, childID string) (string, error) {
	var remote string
	err := tx.QueryRow(ctx, `select coalesce(remote_id,'') from poker_publication_steps where operation_key=$1 and session_id=$2 and state='confirmed'`, createKey(snap, childID), snap.Scope.SessionID).Scan(&remote)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return remote, err
}
func (e *Engine) advance(ctx context.Context, s Scope, id string, step Step) (bool, error) {
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	snap, _, err := e.current(ctx, tx, s, id)
	if err != nil {
		return false, err
	}
	var state Outcome
	var live bool
	var originalType string
	if err = tx.QueryRow(ctx, `select state,coalesce(lease_until>now(),false),issue_type from poker_publication_steps where operation_key=$1 and session_id=$2 for update`, step.Key, s.SessionID).Scan(&state, &live, &originalType); err != nil {
		return false, err
	}
	if state == Confirmed && step.Kind == "create" && originalType != step.Binding.IssueType {
		return false, ErrPaused
	}
	if state == Confirmed {
		return true, nil
	}
	if live {
		return false, ErrPaused
	}
	var unsettled bool
	if err = tx.QueryRow(ctx, `select exists(select 1 from poker_publication_steps where target_key=$1 and operation_key<>$2 and state='unknown')`, step.TargetKey, step.Key).Scan(&unsettled); err != nil {
		return false, err
	}
	if unsettled {
		return false, ErrPaused
	}
	waiting := step.Waiting
	if step.Kind == "parent" || step.Kind == "estimate" {
		step.RemoteID, err = e.endpoint(ctx, tx, snap, step.ChildID)
		if err != nil {
			return false, err
		}
		waiting = waiting || step.RemoteID == ""
	}
	if step.Kind == "dependency" || step.Kind == "remove-dependency" {
		step.BlockerRemoteID, err = e.endpoint(ctx, tx, snap, step.BlockerID)
		if err != nil {
			return false, err
		}
		step.DependentRemoteID, err = e.endpoint(ctx, tx, snap, step.DependentID)
		if err != nil {
			return false, err
		}
		waiting = waiting || step.BlockerRemoteID == "" || step.DependentRemoteID == ""
	}
	if waiting {
		if _, err = tx.Exec(ctx, `update poker_publication_steps set state='waiting-for-issues',updated_at=now() where operation_key=$1`, step.Key); err != nil {
			return false, err
		}
		return false, tx.Commit(ctx)
	}
	step.PreviousOutcome = state
	var lease string
	// Persist before Inspect/Apply: an expired lease remains unknown, not pending.
	if err = tx.QueryRow(ctx, `update poker_publication_steps set state='unknown',lease_id=gen_random_uuid(),lease_until=now()+interval '1 minute',attempts=attempts+1,updated_at=now() where operation_key=$1 returning lease_id::text,attempts`, step.Key).Scan(&lease, &step.DispatchAttempt); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	observation, inspectErr := e.Provider.Inspect(callCtx, s, step)
	result := Unknown
	remote := ""
	if inspectErr == nil && observation.Known {
		if observation.Matches {
			result = Confirmed
			remote = observation.RemoteID
			if step.Kind == "create" && remote == "" {
				result = Unknown
			}
		} else if !observation.MutationAllowed {
			result = Failed
		} else if step.Kind == "estimate" && step.Value == "" {
			// A blank accepted estimate never authorizes overwriting a provider default.
			result = Failed
		} else {
			preflight, preflightErr := e.Pool.Begin(callCtx)
			if preflightErr != nil {
				return false, preflightErr
			}
			_, _, preflightErr = e.current(callCtx, preflight, s, id)
			preflight.Rollback(callCtx)
			if preflightErr != nil {
				return false, preflightErr
			}
			outcome, applyErr := e.Provider.Apply(callCtx, s, step)
			if applyErr == nil && outcome == Failed {
				result = Failed
			} else {
				// HTTP success alone is not a receipt. Read back the exact object/pair/value.
				verify, verifyErr := e.Provider.Inspect(callCtx, s, step)
				if verifyErr == nil && verify.Known && verify.Matches && (step.Kind != "create" || verify.RemoteID != "") {
					result = Confirmed
					remote = verify.RemoteID
				}
			}
		}
	}
	// Check current authority, captured generation and content again before receipt.
	// A transmitted effect cannot be undone by a local revoke; leave it unknown.
	finish, err := e.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer finish.Rollback(ctx)
	if _, _, err = e.current(ctx, finish, s, id); err != nil {
		return false, err
	}
	if len(remote) > 256 {
		result = Unknown
		remote = ""
	}
	tag, err := finish.Exec(ctx, `update poker_publication_steps set state=$3,remote_id=nullif($4,''),lease_id=null,lease_until=null,updated_at=now() where operation_key=$1 and lease_id=$2 and lease_until>now()`, step.Key, lease, result, remote)
	if err != nil {
		return false, fmt.Errorf("recording publication result: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return false, ErrPaused
	}
	if err = finish.Commit(ctx); err != nil {
		return false, err
	}
	return result == Confirmed, nil
}
