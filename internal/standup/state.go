package standup

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

type Config struct {
	SecondsPerPerson int `json:"secondsPerPerson"`
}

func (c Config) secondsOrDefault() int {
	if c.SecondsPerPerson <= 0 {
		return 90
	}
	return c.SecondsPerPerson
}

type WireEntry struct {
	UserID    string  `json:"userId"`
	Yesterday string  `json:"yesterday"`
	Today     string  `json:"today"`
	Blockers  string  `json:"blockers"`
	Position  float64 `json:"position"`
	Skipped   bool    `json:"skipped"`
	Ready     bool    `json:"ready"`
}

// WireCommitment is one open commitment.
//
// UserID rather than a "mine" flag: a StateFunc builds one payload that is
// broadcast to every socket in the room (see session.StateFunc), so it has no
// viewer to compare against. The client owns that comparison, exactly as it
// already does for WireEntry.
//
// Stuck is computed here rather than sent as a threshold for the client to
// apply, so every screen agrees on what stalled means.
type WireCommitment struct {
	ID      string `json:"id"`
	UserID  string `json:"userId"`
	Text    string `json:"text"`
	Carried int    `json:"carried"`
	Stuck   bool   `json:"stuck"`
	// OpenedHere is true when the commitment was opened in this very session.
	// Read from opened_session_id rather than inferred from Carried: a
	// commitment opened last week and never answered also has Carried 0, so
	// the count cannot tell "made just now" from "carried over unanswered".
	// The client uses it to keep "did that land?" off something typed a
	// minute ago, and because it comes off the row it survives a reconnect.
	// Null — the opening room was deleted — is false: there is no origin room
	// left for the commitment to have been opened in.
	OpenedHere bool `json:"openedHere"`
}

// WireKudo is one kudo given in this session, for the closing beat.
//
// Ids and text only: names come off the envelope's participants, as they do
// for every other slice of this state. There is deliberately no count and no
// per-person total — see 0033_kudos.sql. This payload is broadcast to every
// socket in the room, guests included, which is the accepted behaviour: a
// guest reads what is said in the room it is in, and the wall around it stays
// out of reach.
type WireKudo struct {
	ID         string `json:"id"`
	FromUserID string `json:"fromUserId"`
	ToUserID   string `json:"toUserId"`
	Text       string `json:"text"`
}

// stuckAfter is the number of "not yet" answers at which a commitment is
// showing as stalled.
const stuckAfter = 2

type State struct {
	Entries          []WireEntry      `json:"entries"`
	Commitments      []WireCommitment `json:"commitments"`
	Kudos            []WireKudo       `json:"kudos"`
	CurrentSpeakerID *string          `json:"currentSpeakerId"`
	SpeakerStartedAt *time.Time       `json:"speakerStartedAt"`
	SecondsPerPerson int              `json:"secondsPerPerson"`
}

// Kind describes the standup session kind for the core registry.
func Kind() session.Kind {
	return session.Kind{
		Name:      "standup",
		State:     buildState,
		NewConfig: func() any { return &Config{} },
		CSV:       exportCSV,
		Actions:   actions(),
	}
}

func buildState(ctx context.Context, pool *pgxpool.Pool, sess store.Session) (any, error) {
	var cfg Config
	json.Unmarshal(sess.Config, &cfg)

	st := State{
		Entries:          []WireEntry{},
		Commitments:      []WireCommitment{},
		Kudos:            []WireKudo{},
		SecondsPerPerson: cfg.secondsOrDefault(),
	}

	var speaker *string
	var started *time.Time
	if err := pool.QueryRow(ctx,
		"select current_speaker_id::text, speaker_started_at from sessions where id = $1", sess.ID,
	).Scan(&speaker, &started); err != nil {
		return nil, err
	}
	st.CurrentSpeakerID = speaker
	st.SpeakerStartedAt = started

	rows, err := pool.Query(ctx, `
		select user_id::text, yesterday, today, blockers, position, skipped, ready
		from standup_entries where session_id = $1 order by position`, sess.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e WireEntry
		if err := rows.Scan(&e.UserID, &e.Yesterday, &e.Today, &e.Blockers, &e.Position, &e.Skipped, &e.Ready); err != nil {
			return nil, err
		}
		st.Entries = append(st.Entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// The open set for the space IS the carry-over list, read directly. There
	// is no lookback across sessions: a commitment opened weeks ago and never
	// answered is simply still open.
	crows, err := pool.Query(ctx, `
		select id::text, user_id::text, text, carried,
		       coalesce(opened_session_id = $2, false) as opened_here
		from standup_commitments
		where space_id = $1 and closed_at is null
		order by created_at, id`, sess.SpaceID, sess.ID)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for crows.Next() {
		var c WireCommitment
		if err := crows.Scan(&c.ID, &c.UserID, &c.Text, &c.Carried, &c.OpenedHere); err != nil {
			return nil, err
		}
		c.Stuck = c.Carried >= stuckAfter
		st.Commitments = append(st.Commitments, c)
	}
	if err := crows.Err(); err != nil {
		return nil, err
	}

	// This session's kudos only, oldest first — the order they were given in,
	// which is how the closing beat reads. The wall reads the same rows the
	// other way round for its own surface.
	krows, err := pool.Query(ctx, `
		select id::text, from_user_id::text, to_user_id::text, text
		from kudos where session_id = $1 order by created_at, id`, sess.ID)
	if err != nil {
		return nil, err
	}
	defer krows.Close()
	for krows.Next() {
		var k WireKudo
		if err := krows.Scan(&k.ID, &k.FromUserID, &k.ToUserID, &k.Text); err != nil {
			return nil, err
		}
		st.Kudos = append(st.Kudos, k)
	}
	return st, krows.Err()
}
