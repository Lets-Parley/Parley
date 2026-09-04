package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNoSession      = errors.New("no such session")
	ErrNotEligible    = errors.New("not eligible")
	ErrNotFacilitator = errors.New("not facilitator")
	ErrSessionEnded   = errors.New("session ended")
	ErrKindRetired    = errors.New("session kind retired")
	// ErrKindElsewhere is returned when a space's org is not the org the kind
	// belongs to. A kind a plugin provides belongs to the org that installed
	// it; a core kind belongs to no org and so is never this.
	ErrKindElsewhere = errors.New("session kind belongs to another org")
)

// FacilitatorGrace is how long a facilitator must be unseen before any member
// may claim the role.
const FacilitatorGrace = 60 * time.Second

type Session struct {
	ID                string     `json:"id"`
	SpaceID           string     `json:"spaceId"`
	Kind              string     `json:"kind"`
	Title             string     `json:"title"`
	Config            []byte     `json:"-"`
	Phase             string     `json:"phase"`
	Revealed          bool       `json:"revealed"`
	Version           int64      `json:"version"`
	FacilitatorID     string     `json:"facilitatorId"`
	FacilitatorSeenAt time.Time  `json:"-"`
	CreatedAt         time.Time  `json:"createdAt"`
	EndedAt           *time.Time `json:"endedAt"`
}

type Sessions struct {
	Pool *pgxpool.Pool
}

const sessionCols = "id, space_id, kind, title, config, phase, revealed, version, facilitator_id, facilitator_seen_at, created_at, ended_at"

func scanSession(row pgx.Row) (Session, error) {
	var s Session
	err := row.Scan(&s.ID, &s.SpaceID, &s.Kind, &s.Title, &s.Config, &s.Phase,
		&s.Revealed, &s.Version, &s.FacilitatorID, &s.FacilitatorSeenAt, &s.CreatedAt, &s.EndedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNoSession
	}
	return s, err
}

func (s *Sessions) Create(ctx context.Context, spaceID, kind, title string, config []byte, facilitatorID string, limit int) (Session, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "select id from spaces where id = $1 for update", spaceID); err != nil {
		return Session{}, err
	}
	var count int
	if err := tx.QueryRow(ctx, "select count(*) from sessions where space_id = $1", spaceID).Scan(&count); err != nil {
		return Session{}, err
	}
	if count >= limit {
		return Session{}, ErrQuotaExceeded
	}
	// The retired-kind guard rides along with the insert so the two see one
	// snapshot: a kind retired between a separate check and this statement
	// would otherwise still get a session. A kind with no session_kinds row at
	// all satisfies the guard and is left to the foreign key, which names the
	// missing row far better than a retired-kind refusal would.
	// The org half rides along with it for the same reason: a kind that
	// belongs to another org's install must not be creatable here, and reading
	// the ownership separately would let an install land between the read and
	// the insert.
	sess, err := scanSession(tx.QueryRow(ctx,
		"insert into sessions (space_id, kind, title, config, facilitator_id) "+
			"select $1, $2, $3, $4, $5 "+
			"where not exists (select 1 from session_kinds k where k.kind = $2 and ("+
			"  k.retired_at is not null"+
			"  or (k.org_id is not null and k.org_id <> (select org_id from spaces where id = $1))"+
			")) "+
			"returning "+sessionCols,
		spaceID, kind, title, config, facilitatorID))
	if errors.Is(err, ErrNoSession) {
		// Both refusals look identical from here — one statement, no row — so
		// the reason is read back for the message only. The refusal already
		// happened; this cannot turn it into an acceptance.
		return Session{}, refusedKind(ctx, tx, spaceID, kind)
	}
	if err != nil {
		return Session{}, err
	}
	return sess, tx.Commit(ctx)
}

// refusedKind says which guard the insert's predicate refused on. It runs in
// the same transaction, after the refusal, so what it reads is the snapshot
// the refusal was made against.
func refusedKind(ctx context.Context, tx pgx.Tx, spaceID, kind string) error {
	var retired bool
	err := tx.QueryRow(ctx,
		"select k.retired_at is not null from session_kinds k where k.kind = $1", kind).Scan(&retired)
	if errors.Is(err, pgx.ErrNoRows) {
		// No row at all cannot reach here — the predicate lets it through to
		// the foreign key — but a kind deleted underneath us would, and
		// "retired" is the truthful answer for a kind that is gone.
		return ErrKindRetired
	}
	if err != nil {
		return fmt.Errorf("reading why session kind %q was refused: %w", kind, err)
	}
	if retired {
		return ErrKindRetired
	}
	return ErrKindElsewhere
}

// OfferableKinds lists the kinds this org may create: the instance-wide ones
// plus the ones its own installs provide, minus anything retired, in name
// order. Retiring a kind keeps its row — existing sessions still resolve
// through the foreign key — so this is what stops it being offered again.
func (s *Sessions) OfferableKinds(ctx context.Context, orgID string) ([]string, error) {
	// A kind whose install is switched off stops being offered at once: the
	// row survives a disable, because a disable is reversible, so it is the
	// install's own enabled flag that decides.
	rows, err := s.Pool.Query(ctx, `
		select k.kind from session_kinds k
		left join plugin_installs p on p.name = k.provider and p.org_id = k.org_id
		where k.retired_at is null
		  and (k.org_id is null or (k.org_id = $1 and p.enabled))
		order by k.kind`, orgID)
	if err != nil {
		return nil, fmt.Errorf("listing offerable session kinds: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var kind string
		if err := rows.Scan(&kind); err != nil {
			return nil, fmt.Errorf("scanning an offerable session kind: %w", err)
		}
		out = append(out, kind)
	}
	return out, rows.Err()
}

func (s *Sessions) ByID(ctx context.Context, id string) (Session, error) {
	return scanSession(s.Pool.QueryRow(ctx, "select "+sessionCols+" from sessions where id = $1", id))
}

func (s *Sessions) ListBySpace(ctx context.Context, spaceID string) ([]Session, error) {
	rows, err := s.Pool.Query(ctx,
		"select "+sessionCols+" from sessions where space_id = $1 order by created_at desc limit 50", spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

func (s *Sessions) withLockedSession(ctx context.Context, id, actorID string, activeOnly bool, fn func(pgx.Tx, Session) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	sess, err := scanSession(tx.QueryRow(ctx,
		"select "+sessionCols+" from sessions where id = $1 for update", id))
	if err != nil {
		return err
	}
	if sess.FacilitatorID != actorID {
		return ErrNotFacilitator
	}
	if activeOnly && sess.EndedAt != nil {
		return ErrSessionEnded
	}
	if err := fn(tx, sess); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// WithActiveSession locks the session row, revalidates current facilitator
// authority when required, and commits fn in the same transaction. Authority
// is checked before closure so callers can distinguish 403 from 409.
func (s *Sessions) WithActiveSession(ctx context.Context, id, actorID string, facilitatorOnly bool, fn func(pgx.Tx, Session) error) error {
	if facilitatorOnly {
		return s.withLockedSession(ctx, id, actorID, true, fn)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	sess, err := scanSession(tx.QueryRow(ctx,
		"select "+sessionCols+" from sessions where id = $1 for update", id))
	if err != nil {
		return err
	}
	if sess.EndedAt != nil {
		return ErrSessionEnded
	}
	if err := fn(tx, sess); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Sessions) SetEnded(ctx context.Context, id, actorID string, ended bool) error {
	return s.withLockedSession(ctx, id, actorID, false, func(tx pgx.Tx, _ Session) error {
		// The ended_at predicate is what makes this idempotent: a retried or
		// double-clicked DELETE must not move the recorded end time forward,
		// bump the version, or broadcast a second time. Under the row lock, so
		// two concurrent closes cannot both see it as open.
		var q string
		if ended {
			q = "update sessions set ended_at = now(), version = version + 1 where id = $1 and ended_at is null"
		} else {
			q = "update sessions set ended_at = null, version = version + 1 where id = $1 and ended_at is not null"
		}
		_, err := tx.Exec(ctx, q, id)
		return err
	})
}

func (s *Sessions) TransferFacilitator(ctx context.Context, id, actorID, toUserID string) error {
	return s.withLockedSession(ctx, id, actorID, false, func(tx pgx.Tx, sess Session) error {
		if toUserID == sess.FacilitatorID {
			return nil
		}
		var member bool
		if err := tx.QueryRow(ctx,
			"select exists (select 1 from members where space_id = $1 and user_id = $2)",
			sess.SpaceID, toUserID).Scan(&member); err != nil {
			return err
		}
		if !member {
			return ErrNotEligible
		}
		_, err := tx.Exec(ctx, `
			update sessions set facilitator_id = $2, facilitator_seen_at = now(), version = version + 1
			where id = $1`, id, toUserID)
		return err
	})
}

// ClaimFacilitator succeeds only when the current facilitator has not been seen
// within the grace period. The conditional UPDATE serializes concurrent claims:
// exactly one wins.
//
// A link-bound identity is excluded in the statement itself, behind the
// middleware that already refuses it: seizing an idle room is the escalation a
// signed link most obviously invites, so it is refused twice.
func (s *Sessions) ClaimFacilitator(ctx context.Context, id, claimerID string) error {
	tag, err := s.Pool.Exec(ctx, `
		update sessions set facilitator_id = $2, facilitator_seen_at = now(), version = version + 1
		where id = $1 and facilitator_id <> $2 and facilitator_seen_at < now() - $3::interval
		  and exists (select 1 from users u where u.id = $2 and u.link_id is null)`,
		id, claimerID, FacilitatorGrace)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotEligible
	}
	return nil
}

// TouchFacilitatorSeen records liveness; called on WS connect and every pong
// from the facilitator's connection.
func (s *Sessions) TouchFacilitatorSeen(ctx context.Context, id, userID string) error {
	_, err := s.Pool.Exec(ctx,
		"update sessions set facilitator_seen_at = now() where id = $1 and facilitator_id = $2",
		id, userID)
	return err
}

func (s *Sessions) BumpVersion(ctx context.Context, id string) error {
	_, err := s.Pool.Exec(ctx, "update sessions set version = version + 1 where id = $1", id)
	return err
}

// Rename retitles a room. Scoped by space as well as id so a caller authorized
// for one space can never retitle a room in another by guessing its id — the
// handler's authorization is over the space, so the query must be too.
//
// The version bump is what pushes the new title to everyone already in the
// room; without it the rename would only appear on the next reload.
func (s *Sessions) Rename(ctx context.Context, id, spaceID, title string) error {
	tag, err := s.Pool.Exec(ctx,
		"update sessions set title = $3, version = version + 1 where id = $1 and space_id = $2",
		id, spaceID, title)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoSession
	}
	return nil
}

// Delete removes a room and its kind state. Stories, standup rows and presence
// cascade from the session row, so this is the whole teardown.
//
// Scoped by space for the same reason Rename is. Deleting an already-deleted
// room reports ErrNoSession rather than succeeding quietly: unlike closing,
// this is not something a client retries blind, and a 404 is the honest answer
// when the id names nothing.
func (s *Sessions) Delete(ctx context.Context, id, spaceID string) error {
	tag, err := s.Pool.Exec(ctx, "delete from sessions where id = $1 and space_id = $2", id, spaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoSession
	}
	return nil
}
