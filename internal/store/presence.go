package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxSessionParticipants is the hard ceiling on who belongs to one session.
// snapshotVoters copies this table into round_voters, so without a bound a
// long-lived room's open rounds grow without limit. Fixed; not an env knob.
const MaxSessionParticipants = 200

// maxSessionParticipants is the live cap; tests shrink it so they do not have
// to insert two hundred users to prove the prune.
var maxSessionParticipants = MaxSessionParticipants

// ParticipantCap is the live ceiling on session_participants (and thus on
// open-voting snapshots). Production code reads this; tests may shrink it via
// SetMaxSessionParticipantsForTest.
func ParticipantCap() int { return maxSessionParticipants }

// SetMaxSessionParticipantsForTest overrides the cap for the calling test and
// returns the previous value so the test can restore it.
func SetMaxSessionParticipantsForTest(n int) int {
	old := maxSessionParticipants
	maxSessionParticipants = n
	return old
}

// Presence records who is holding a live connection to a session, across every
// replica. It replaces the per-process view that was correct only while Parley
// ran as a single pod.
type Presence struct {
	Pool *pgxpool.Pool
	// ReplicaID identifies this process. Rows are keyed by it so one pod's
	// disconnects never erase another pod's people.
	ReplicaID string
	// Window is how long a row counts for without being touched again. Clients
	// are pinged well inside it; see the caller for how it is derived.
	Window time.Duration
}

// Seen records that a user is connected here, now. Called on attach and on
// every pong, so an unchanged connection keeps refreshing its row.
//
// Belonging to the session is a different question and is recorded by Join on
// attach only — writing session_participants on every pong was a PK probe on
// the hottest path in the room for no gain after the first insert.
func (p *Presence) Seen(ctx context.Context, sessionID, userID string) error {
	_, err := p.Pool.Exec(ctx, `
		insert into session_presence (session_id, user_id, replica_id, seen_at)
		values ($1, $2, $3, now())
		on conflict (session_id, user_id, replica_id) do update set seen_at = now()`,
		sessionID, userID, p.ReplicaID)
	return err
}

// Join records, once and durably, that this person belongs to the session.
// Presence answers "connected recently" and is erased by Gone and Sweep; an
// asynchronous round has to wait for people who are away, and cannot ask a
// table that forgets them. Turning up in the room is what makes somebody a
// participant. Called on attach only.
//
// When the session is already at the cap, the oldest joiner is dropped so the
// table — and every open-voting snapshot that copies it — stays bounded. The
// current facilitator is never dropped: their socket can outlive a prune of
// the oldest rows, and a later snapshot that omitted them would let the rest
// of the table auto-reveal before they cast.
func (p *Presence) Join(ctx context.Context, sessionID, userID string) error {
	tx, err := p.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning session join: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		insert into session_participants (session_id, user_id)
		values ($1, $2)
		on conflict do nothing`, sessionID, userID); err != nil {
		return fmt.Errorf("recording session participant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		delete from session_participants
		where ctid in (
			select ctid from (
				select sp.ctid,
					row_number() over (
						order by (sp.user_id = s.facilitator_id) desc,
						         sp.joined_at desc, sp.user_id desc) as rn
				from session_participants sp
				join sessions s on s.id = sp.session_id
				where sp.session_id = $1
			) ranked
			where rn > $2
		)`, sessionID, maxSessionParticipants); err != nil {
		return fmt.Errorf("bounding session participants: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing session join: %w", err)
	}
	return nil
}

// Gone drops this replica's row when a connection closes, so the room updates
// immediately instead of waiting for the row to age out.
func (p *Presence) Gone(ctx context.Context, sessionID, userID string) error {
	_, err := p.Pool.Exec(ctx,
		`delete from session_presence
		 where session_id = $1 and user_id = $2 and replica_id = $3`,
		sessionID, userID, p.ReplicaID)
	return err
}

// GoneTx is Gone on the caller's transaction rather than the pool, so a
// presence clear can commit atomically with whatever else that transaction is
// doing. A facilitator removal needs that: pruning the open round and clearing
// presence in two separate transactions leaves a window where the round has
// already been altered — possibly auto-revealed — for somebody who is still
// fully connected.
func (p *Presence) GoneTx(ctx context.Context, tx pgx.Tx, sessionID, userID string) error {
	_, err := tx.Exec(ctx,
		`delete from session_presence
		 where session_id = $1 and user_id = $2 and replica_id = $3`,
		sessionID, userID, p.ReplicaID)
	return err
}

// InSession lists the distinct users currently connected to a session on any
// replica.
//
// The session_id predicate is the difference between "who is in this room" and
// "who is using Parley right now" — without it every room would list everybody.
func (p *Presence) InSession(ctx context.Context, sessionID string) ([]string, error) {
	rows, err := p.Pool.Query(ctx, `
		select distinct user_id::text from session_presence
		where session_id = $1 and seen_at > now() - $2::interval`,
		sessionID, p.Window.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// InSessions answers InSession for several sessions at once, so a page that
// lists a whole space costs one round trip instead of one per session.
func (p *Presence) InSessions(ctx context.Context, sessionIDs []string) (map[string][]string, error) {
	out := map[string][]string{}
	if len(sessionIDs) == 0 {
		return out, nil
	}
	rows, err := p.Pool.Query(ctx, `
		select distinct session_id::text, user_id::text from session_presence
		where session_id::text = any($1) and seen_at > now() - $2::interval`,
		sessionIDs, p.Window.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sessionID, userID string
		if err := rows.Scan(&sessionID, &userID); err != nil {
			return nil, err
		}
		out[sessionID] = append(out[sessionID], userID)
	}
	return out, rows.Err()
}

// Sweep deletes rows nobody has refreshed inside the window. A pod that is
// SIGKILLed never runs Gone, so without this its people haunt the room.
func (p *Presence) Sweep(ctx context.Context) error {
	_, err := p.Pool.Exec(ctx,
		`delete from session_presence where seen_at <= now() - $1::interval`,
		p.Window.String())
	return err
}
