package publication

import (
	"context"
	"time"
)

// Verify reconciles old unknown steps without authorizing another write. It is
// usable after content changes, but still requires current local/provider access.
func (e *Engine) Verify(ctx context.Context, s Scope, id string) error {
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = e.authorize(ctx, tx, s, false); err != nil {
		return err
	}
	request, review, err := e.readReview(ctx, tx, s, id)
	if err != nil {
		return err
	}
	tx.Rollback(ctx)
	for _, step := range review.Steps {
		tx, err = e.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		if err = e.authorize(ctx, tx, s, false); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if e.Provider == nil {
			tx.Rollback(ctx)
			return ErrPaused
		}
		cap, err := e.Provider.Capability(ctx, s)
		if err != nil || !cap.Verified || digest(cap) != digest(step.Binding) {
			tx.Rollback(ctx)
			return ErrPaused
		}
		var state Outcome
		var live bool
		err = tx.QueryRow(ctx, `select state,coalesce(lease_until>now(),false) from poker_publication_steps where operation_key=$1 and session_id=$2 for update`, step.Key, s.SessionID).Scan(&state, &live)
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		if state != Unknown {
			tx.Rollback(ctx)
			continue
		}
		if live {
			tx.Rollback(ctx)
			return ErrPaused
		}
		snap := snapshot{Scope: s, ParentID: request.ParentID, Capability: cap}
		if step.Kind == "parent" || step.Kind == "estimate" {
			step.RemoteID, err = e.endpoint(ctx, tx, snap, step.ChildID)
		}
		if step.Kind == "dependency" || step.Kind == "remove-dependency" {
			step.BlockerRemoteID, err = e.endpoint(ctx, tx, snap, step.BlockerID)
			if err == nil {
				step.DependentRemoteID, err = e.endpoint(ctx, tx, snap, step.DependentID)
			}
		}
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		if (step.Kind == "parent" || step.Kind == "estimate") && step.RemoteID == "" {
			tx.Rollback(ctx)
			return ErrPaused
		}
		if (step.Kind == "dependency" || step.Kind == "remove-dependency") && (step.BlockerRemoteID == "" || step.DependentRemoteID == "") {
			tx.Rollback(ctx)
			return ErrPaused
		}
		var lease string
		err = tx.QueryRow(ctx, `update poker_publication_steps set lease_id=gen_random_uuid(),lease_until=now()+interval '1 minute',updated_at=now() where operation_key=$1 returning lease_id::text`, step.Key).Scan(&lease)
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		observation, inspectErr := e.Provider.Inspect(callCtx, s, step)
		cancel()
		result := Unknown
		remote := ""
		if inspectErr == nil && observation.Known {
			result = Failed
			if observation.Matches && (step.Kind != "create" || observation.RemoteID != "") {
				result = Confirmed
				remote = observation.RemoteID
			}
		}
		finish, err := e.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		if err = e.authorize(ctx, finish, s, false); err != nil {
			finish.Rollback(ctx)
			return err
		}
		cap, err = e.Provider.Capability(ctx, s)
		if err != nil || digest(cap) != digest(step.Binding) {
			finish.Rollback(ctx)
			return ErrPaused
		}
		if len(remote) > 256 {
			result = Unknown
			remote = ""
		}
		tag, err := finish.Exec(ctx, `update poker_publication_steps set state=$3,remote_id=nullif($4,''),lease_id=null,lease_until=null,updated_at=now() where operation_key=$1 and lease_id=$2 and lease_until>now()`, step.Key, lease, result, remote)
		if err != nil {
			finish.Rollback(ctx)
			return err
		}
		if tag.RowsAffected() != 1 {
			finish.Rollback(ctx)
			return ErrPaused
		}
		if err = finish.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}
