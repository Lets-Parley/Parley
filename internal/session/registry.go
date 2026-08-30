// Package session owns the wire envelope and the kind registry — the single
// place a session kind (poker, standup, or a future extension) plugs into the
// core. A new kind describes itself with a Kind struct, gets registered into
// the server's Registry at wiring time, and touches nothing else.
package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/store"
)

// StateFunc builds the kind-specific payload for the wire envelope. It must
// only ever return client-safe (redacted) data.
type StateFunc func(ctx context.Context, pool *pgxpool.Pool, sess store.Session) (any, error)

// Kind is everything the core needs to know about a session kind: how to
// build its state payload, what its config document looks like, and how to
// export it. One struct rather than one map per capability — two maps keyed by
// the same string is a desync waiting to happen.
type Kind struct {
	Name string
	// State builds the kind's client-safe payload. Optional only in tests.
	State StateFunc
	// NewConfig returns a pointer to the kind's config struct, decoded with
	// DisallowUnknownFields.
	NewConfig func() any
	// CSV renders the export rows. A kind without one has no export.
	CSV CSVFunc
	// Actions is the kind's dispatch table, keyed by the {action} segment of
	// POST /sessions/{id}/actions/{action}.
	Actions map[string]Action
}

// Registry holds the session kinds a server knows about. Build one at wiring
// time, register every kind into it, and hand it to the router; it is not
// written to after that, so it carries no lock.
type Registry struct {
	kinds map[string]Kind
}

func NewRegistry() *Registry {
	return &Registry{kinds: map[string]Kind{}}
}

// Register wires a session kind into the dispatcher. A duplicate name is a
// wiring mistake and returns an error rather than overwriting the first
// registration.
func (r *Registry) Register(k Kind) error {
	if k.Name == "" {
		return fmt.Errorf("registering a session kind: name is empty")
	}
	if _, ok := r.kinds[k.Name]; ok {
		return fmt.Errorf("registering session kind %q: already registered", k.Name)
	}
	// The cross-site guard exempts GET, on the assumption that a GET changes
	// nothing. Every action is a write, so an action answering GET would be a
	// write with no CSRF protection at all. Refuse it at wiring time — a
	// third-party kind is registered the same way and gets the same refusal.
	for name, a := range k.Actions {
		if a.Verb == http.MethodGet || a.Verb == http.MethodHead {
			return fmt.Errorf("registering session kind %q: action %q answers %s, but actions are writes and the cross-site guard exempts %s", k.Name, name, a.Verb, a.Verb)
		}
	}
	r.kinds[k.Name] = k
	return nil
}

// Unregister removes a kind, erroring if it was never registered.
func (r *Registry) Unregister(name string) error {
	if _, ok := r.kinds[name]; !ok {
		return fmt.Errorf("unregistering session kind %q: not registered", name)
	}
	delete(r.kinds, name)
	return nil
}

// Names returns the registered kind names, sorted. Callers use it to build
// messages that stay true whatever set of kinds is registered.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.kinds))
	for name := range r.kinds {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (r *Registry) Known(kind string) bool {
	_, ok := r.kinds[kind]
	return ok
}

// ParseConfig validates a raw config document against the kind's struct.
func (r *Registry) ParseConfig(kind string, raw []byte) ([]byte, error) {
	k, ok := r.kinds[kind]
	if !ok {
		return nil, fmt.Errorf("unknown session kind %q", kind)
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	cfg := k.NewConfig()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(cfg); err != nil {
		return nil, err
	}
	// The decoder stops after one value. Refuse anything following it rather
	// than silently dropping it: a caller outside the API handler has no outer
	// decode to reject the trailing half for them.
	if dec.More() {
		return nil, fmt.Errorf("trailing data after the %s config document", kind)
	}
	// A structural decode says the document is the right shape, not that its
	// values are allowed. A kind that cares validates itself here — the only
	// gate between a space member and a stored config.
	if v, ok := cfg.(interface{ Validate() error }); ok {
		if err := v.Validate(); err != nil {
			return nil, fmt.Errorf("validating the %s config document: %w", kind, err)
		}
	}
	return json.Marshal(cfg)
}

// Envelope is the wire state shared by every kind. State carries the
// kind-specific payload.
type Envelope struct {
	ID                   string     `json:"id"`
	Kind                 string     `json:"kind"`
	Title                string     `json:"title"`
	Phase                string     `json:"phase"`
	Revealed             bool       `json:"revealed"`
	Version              int64      `json:"version"`
	FacilitatorID        string     `json:"facilitatorId"`
	FacilitatorConnected bool       `json:"facilitatorConnected"`
	FacilitatorOffline   *time.Time `json:"facilitatorOfflineSince,omitempty"`
	EndedAt              *time.Time `json:"endedAt"`
	Presence             []string   `json:"presence"`
	SpaceSlug            string     `json:"spaceSlug"`
	// OrgSlug is the org segment of the space's URL. The session page builds
	// a space API URL out of both halves, so a missing one breaks its lookup
	// rather than merely a label.
	OrgSlug      string    `json:"orgSlug"`
	Participants []Person  `json:"participants"`
	ServerTime   time.Time `json:"serverTime"`
	State        any       `json:"state"`
}

// Person is a roster entry carried in the envelope so clients can render
// names and avatars without a second fetch.
type Person struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarHue int    `json:"avatarHue"`
	Spectator bool   `json:"spectator"`
	// Guest marks a seat held by a signed link rather than by membership of
	// the space. Nothing stops a guest choosing a member's display name, so
	// the roster has to say which seat is which — server-side, because a
	// client cannot tell the two apart from a name alone.
	Guest bool `json:"guest"`
	// The chosen avatar. Empty ids mean the client renders the hue alone.
	AvatarIcon string `json:"avatarIcon"`
}

// roster names everybody the room can render: the space's members, plus the
// guests who joined this one session by signed link. A guest has no members
// row and so no spectator flag — it votes like anybody else in the room, the
// same reading maybeAutoReveal takes of the denominator — so it is seated as a
// participant, never a spectator.
//
// pastGuests widens the guest half from the live links to every link the room
// ever carried. The wire roster wants the live ones: a revoked or expired link
// is a seat nobody can occupy any more. An export wants all of them, because
// a name in a finished meeting's CSV must not depend on whether the link that
// let its owner in is still good.
func roster(ctx context.Context, pool *pgxpool.Pool, spaceID, sessionID string, pastGuests bool) (string, string, []Person, error) {
	var slug, orgSlug string
	if err := pool.QueryRow(ctx,
		"select sp.slug, o.slug from spaces sp join orgs o on o.id = sp.org_id where sp.id = $1", spaceID,
	).Scan(&slug, &orgSlug); err != nil {
		return "", "", nil, err
	}
	rows, err := pool.Query(ctx, `
		select m.user_id::text, u.name, m.spectator, false, u.avatar_icon
		from members m join users u on u.id = m.user_id
		where m.space_id = $1
		union
		select u.id::text, u.name, false, true, u.avatar_icon
		from users u join session_links l on l.id = u.link_id
		where l.session_id = $2
		  and ($3 or (l.revoked_at is null and l.expires_at > now()))
		order by 2`, spaceID, sessionID, pastGuests)
	if err != nil {
		return "", "", nil, err
	}
	defer rows.Close()
	people := []Person{}
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.UserID, &p.Name, &p.Spectator, &p.Guest, &p.AvatarIcon); err != nil {
			return "", "", nil, err
		}
		p.AvatarHue = store.AvatarHue(p.UserID)
		people = append(people, p)
	}
	return slug, orgSlug, people, rows.Err()
}

// RedactForGuest strips space-level data from an envelope bound for a link
// guest. A signed link is a capability for one room, never membership of the
// space that holds it, so the guest is shown neither the space's join slug nor
// a member who is not taking part in this session — otherwise one meeting link
// enumerates the whole space's roster from the one room it is entitled to.
//
// "Taking part" is presence plus the facilitator, both of which the envelope
// already names, so the roster discloses nothing the guest cannot see anyway.
//
// selfID is the guest the envelope is bound for, and is always kept: presence
// is registered when a socket connects, so a guest reading the room before its
// socket settles would otherwise be told it is not in the room it is in. Pass
// "" where the envelope is not bound to one guest — the broadcast path, which
// builds a single redacted copy for every guest on the socket, and so has a
// presence row for each of them already.
func (e Envelope) RedactForGuest(selfID string) Envelope {
	e.SpaceSlug = ""
	e.OrgSlug = ""
	here := make(map[string]struct{}, len(e.Presence)+2)
	for _, id := range e.Presence {
		here[id] = struct{}{}
	}
	here[e.FacilitatorID] = struct{}{}
	if selfID != "" {
		here[selfID] = struct{}{}
	}
	people := []Person{}
	for _, p := range e.Participants {
		if _, ok := here[p.UserID]; ok {
			people = append(people, p)
		}
	}
	e.Participants = people
	return e
}

// BuildEnvelope assembles the wire state for a session.
//
// Presence comes from the database, not from a hub. That is the whole point:
// any replica must be able to answer "who is in this room" with the same list,
// including people whose sockets are held by a different pod. There is
// deliberately no in-process fallback — a second path here is a path that tests
// exercise and production does not.
func (r *Registry) BuildEnvelope(ctx context.Context, pool *pgxpool.Pool, presence *store.Presence, sessions *store.Sessions, id string) (Envelope, error) {
	return r.buildEnvelope(ctx, pool, presence, sessions, id, false)
}

// BuildExportEnvelope is BuildEnvelope with the roster widened to every guest
// the room ever admitted. It is for the CSV path only: revoking or expiring a
// link takes away a seat, never a name already written into the record.
func (r *Registry) BuildExportEnvelope(ctx context.Context, pool *pgxpool.Pool, presence *store.Presence, sessions *store.Sessions, id string) (Envelope, error) {
	return r.buildEnvelope(ctx, pool, presence, sessions, id, true)
}

func (r *Registry) buildEnvelope(ctx context.Context, pool *pgxpool.Pool, presence *store.Presence, sessions *store.Sessions, id string, pastGuests bool) (Envelope, error) {
	sess, err := sessions.ByID(ctx, id)
	if err != nil {
		return Envelope{}, err
	}
	k, ok := r.kinds[sess.Kind]
	if !ok {
		return Envelope{}, fmt.Errorf("unknown session kind %q", sess.Kind)
	}
	state, err := k.State(ctx, pool, sess)
	if err != nil {
		return Envelope{}, err
	}
	slug, orgSlug, people, err := roster(ctx, pool, sess.SpaceID, sess.ID, pastGuests)
	if err != nil {
		return Envelope{}, err
	}

	connected, err := presence.InSession(ctx, id)
	if err != nil {
		return Envelope{}, err
	}
	facConnected := false
	for _, uid := range connected {
		if uid == sess.FacilitatorID {
			facConnected = true
			break
		}
	}
	env := Envelope{
		ID:                   sess.ID,
		Kind:                 sess.Kind,
		Title:                sess.Title,
		Phase:                sess.Phase,
		Revealed:             sess.Revealed,
		Version:              sess.Version,
		FacilitatorID:        sess.FacilitatorID,
		FacilitatorConnected: facConnected,
		EndedAt:              sess.EndedAt,
		Presence:             connected,
		SpaceSlug:            slug,
		OrgSlug:              orgSlug,
		Participants:         people,
		ServerTime:           time.Now().UTC(),
		State:                state,
	}
	if !facConnected {
		t := sess.FacilitatorSeenAt.UTC()
		env.FacilitatorOffline = &t
	}
	return env, nil
}
