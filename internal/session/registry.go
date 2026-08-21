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
	Participants         []Person   `json:"participants"`
	ServerTime           time.Time  `json:"serverTime"`
	State                any        `json:"state"`
}

// Person is a roster entry carried in the envelope so clients can render
// names and avatars without a second fetch.
type Person struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarHue int    `json:"avatarHue"`
	Spectator bool   `json:"spectator"`
	// The chosen avatar. Empty ids mean the client renders the hue alone.
	AvatarIcon string `json:"avatarIcon"`
}

func roster(ctx context.Context, pool *pgxpool.Pool, spaceID string) (string, []Person, error) {
	var slug string
	if err := pool.QueryRow(ctx, "select slug from spaces where id = $1", spaceID).Scan(&slug); err != nil {
		return "", nil, err
	}
	rows, err := pool.Query(ctx, `
		select m.user_id::text, u.name, m.spectator, u.avatar_icon
		from members m join users u on u.id = m.user_id
		where m.space_id = $1 order by u.name`, spaceID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	people := []Person{}
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.UserID, &p.Name, &p.Spectator, &p.AvatarIcon); err != nil {
			return "", nil, err
		}
		p.AvatarHue = store.AvatarHue(p.UserID)
		people = append(people, p)
	}
	return slug, people, rows.Err()
}

// BuildEnvelope assembles the wire state for a session.
//
// Presence comes from the database, not from a hub. That is the whole point:
// any replica must be able to answer "who is in this room" with the same list,
// including people whose sockets are held by a different pod. There is
// deliberately no in-process fallback — a second path here is a path that tests
// exercise and production does not.
func (r *Registry) BuildEnvelope(ctx context.Context, pool *pgxpool.Pool, presence *store.Presence, sessions *store.Sessions, id string) (Envelope, error) {
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
	slug, people, err := roster(ctx, pool, sess.SpaceID)
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
