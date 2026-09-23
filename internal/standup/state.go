package standup

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// Config is a standup's create-time settings.
//
// Mode and ClosesAt are omitempty so a sync standup stores exactly the
// document it did before async existed: a replica on the previous binary
// decodes with DisallowUnknownFields and would refuse a "mode" key, even an
// empty one. An async config still cannot be read there — every replica has to
// be upgraded before one is created — but nothing written today breaks it.
type Config struct {
	SecondsPerPerson int `json:"secondsPerPerson"`
	// Mode is "sync" (the round-robin; also what an absent mode means) or
	// "async", where people answer on their own time and nobody holds a turn.
	Mode string `json:"mode,omitempty"`
	// ClosesAt is an async standup's published cutoff. Passing it does not
	// end the session: a later answer is accepted and appended like any other.
	ClosesAt *time.Time `json:"closesAt,omitempty"`
}

func (c Config) async() bool { return c.Mode == "async" }

// Validate is called by session.Registry.ParseConfig after the strict decode,
// before the config is re-marshalled for storage. "sync" is folded to no mode
// so a live standup stores the same document it did before async existed.
func (c *Config) Validate() error {
	switch c.Mode {
	case "sync":
		c.Mode = ""
	case "", "async":
	default:
		return errors.New(`mode must be "sync" or "async"`)
	}
	if c.ClosesAt != nil && !c.async() {
		return errors.New("closesAt is only meaningful for an async standup")
	}
	return nil
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
	// PostedAt is when the entry was last written, shown as "posted HH:MM"
	// in the viewer's zone. A late async answer carries it like any other.
	PostedAt time.Time `json:"postedAt"`
	// Name is the author's display name, so a reader whose roster no longer
	// seats the author — a link guest's, which keeps only who is present —
	// still sees who wrote an entry it can already read. Empty for an entry a
	// link guest wrote: that name is whatever the guest typed, and without the
	// roster's guest mark it could pass for a member's.
	Name string `json:"name"`
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

// WireChange is one commitment this standup moved: answered as landed,
// dropped, or carried ("still on it"). It is the digest's "Changed
// commitments" section, and the only place landed and dropped are told apart
// on the wire, so a dropped commitment is never shown as landed.
//
// Outcomes, not totals: there is deliberately no count per person, here or
// anywhere, so nothing turns this into a follow-through rate.
type WireChange struct {
	ID      string `json:"id"`
	UserID  string `json:"userId"`
	Text    string `json:"text"`
	Outcome string `json:"outcome"`
}

// stuckAfter is the number of "not yet" answers at which a commitment is
// showing as stalled.
const stuckAfter = 2

type State struct {
	Entries          []WireEntry      `json:"entries"`
	Commitments      []WireCommitment `json:"commitments"`
	Changes          []WireChange     `json:"changes"`
	Kudos            []WireKudo       `json:"kudos"`
	CurrentSpeakerID *string          `json:"currentSpeakerId"`
	SpeakerStartedAt *time.Time       `json:"speakerStartedAt"`
	SecondsPerPerson int              `json:"secondsPerPerson"`
	// Mode is always spelled out ("sync" or "async") so the client never has
	// to guess what an absent one means.
	Mode     string     `json:"mode"`
	ClosesAt *time.Time `json:"closesAt"`
	// Away is the ids of space members who set themselves away on this
	// standup's day, so the digest does not read them as owing an answer.
	// Served only by an open async standup, and only while its day is today:
	// an ended one keeps its entries only (#388), a reopened one from an
	// earlier day is not today's room, and a live sync room seats whoever is
	// in it. Never sent to a link guest (see ForGuest).
	Away []string `json:"away"`
	// Expected is who an open async standup is waiting on an answer from: the
	// space's non-spectator members, whether or not they have opened the room,
	// plus each link guest that has attached to it (#640). Answered and away
	// people are still in it; the client sets them aside. Absent — not an
	// empty list — for a sync room, which seats whoever is in it (#601), for
	// an ended standup, which keeps its entries only (#388), and for a link
	// guest, to whom the space's roster is none of its business (see ForGuest).
	Expected *[]WireExpected `json:"expected,omitempty"`
}

// WireExpected is one person an async standup is waiting on. Guest marks a
// link guest, for the same reason session.Person carries it.
type WireExpected struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	Guest  bool   `json:"guest"`
}

// ForGuest is the state a link guest is sent. A signed link is a capability
// on one room, not membership of the space, so who in the space is away is
// none of its business. session.Envelope.RedactForGuest calls it.
func (s State) ForGuest() any {
	s.Away = []string{}
	s.Expected = nil
	return s
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
		Changes:          []WireChange{},
		Kudos:            []WireKudo{},
		Away:             []string{},
		SecondsPerPerson: cfg.secondsOrDefault(),
		Mode:             "sync",
		ClosesAt:         cfg.ClosesAt,
	}
	if cfg.async() {
		st.Mode = "async"
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
		select e.user_id::text, e.yesterday, e.today, e.blockers, e.position, e.skipped, e.ready, e.updated_at,
		       case when u.link_id is null then u.name else '' end
		from standup_entries e join users u on u.id = e.user_id
		where e.session_id = $1 order by e.position`, sess.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e WireEntry
		if err := rows.Scan(&e.UserID, &e.Yesterday, &e.Today, &e.Blockers, &e.Position, &e.Skipped, &e.Ready, &e.PostedAt, &e.Name); err != nil {
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

	// What this standup changed, served only while it is open. Once a standup
	// has ended its record keeps its entries only (#388): served from old
	// rooms, these would let a per-person landed and dropped history be
	// rebuilt, and the record would rewrite itself as commitments moved on.
	if sess.EndedAt == nil {
		// A closed row with no reason was closed by a replica that predates
		// closed_reason, and the only close it knew was a landing.
		// carried_session_id is read only on a row still open: a
		// commitment carried here and then closed here reports the close.
		chrows, err := pool.Query(ctx, `
			select id::text, user_id::text, text,
			       case when closed_session_id = $2 then coalesce(closed_reason, 'landed')
			            else 'carried' end
			from standup_commitments
			where space_id = $1
			  and (closed_session_id = $2 or (closed_at is null and carried_session_id = $2))
			order by created_at, id`, sess.SpaceID, sess.ID)
		if err != nil {
			return nil, err
		}
		defer chrows.Close()
		for chrows.Next() {
			var c WireChange
			if err := chrows.Scan(&c.ID, &c.UserID, &c.Text, &c.Outcome); err != nil {
				return nil, err
			}
			st.Changes = append(st.Changes, c)
		}
		if err := chrows.Err(); err != nil {
			return nil, err
		}
	}

	if cfg.async() && sess.EndedAt == nil {
		away, err := awayToday(ctx, pool, sess.ID)
		if err != nil {
			return nil, err
		}
		st.Away = append(st.Away, away...)
		expected, err := expectedPeople(ctx, pool, sess)
		if err != nil {
			return nil, err
		}
		st.Expected = &expected
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

// expectedPeople is who an open async standup is waiting on (#640): the
// space's non-spectator members with no link — the eligibility the frozen
// trend day counts (see store.freezeTrendDays) — whether or not they have
// opened the room, plus each guest whose link is still live and that has
// attached to this room. A link nobody has attached with owes nothing.
func expectedPeople(ctx context.Context, pool *pgxpool.Pool, sess store.Session) ([]WireExpected, error) {
	rows, err := pool.Query(ctx, `
		select u.id::text, u.name, false
		from members m join users u on u.id = m.user_id and u.link_id is null
		where m.space_id = $2 and not m.spectator
		union
		select u.id::text, u.name, true
		from session_participants sp
		join users u on u.id = sp.user_id
		join session_links l on l.id = u.link_id
		where sp.session_id = $1 and l.session_id = $1
		  and l.revoked_at is null and l.expires_at > now()
		order by 2, 1`, sess.ID, sess.SpaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WireExpected{}
	for rows.Next() {
		var p WireExpected
		if err := rows.Scan(&p.UserID, &p.Name, &p.Guest); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
