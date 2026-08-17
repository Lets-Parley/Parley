// Package session owns the wire envelope and the kind registry — the single
// place a session kind (poker, standup, or a future extension) plugs into the
// core. A new kind registers a StateFunc and a config prototype here and
// touches nothing else.
package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/hub"
	"github.com/jacorbello/parley/internal/store"
)

// StateFunc builds the kind-specific payload for the wire envelope. It must
// only ever return client-safe (redacted) data.
type StateFunc func(ctx context.Context, pool *pgxpool.Pool, sess store.Session) (any, error)

type kindSpec struct {
	state     StateFunc
	newConfig func() any
}

var registry = map[string]kindSpec{}

// Register wires a session kind into the dispatcher. newConfig returns a
// pointer to the kind's config struct, decoded with DisallowUnknownFields.
func Register(kind string, state StateFunc, newConfig func() any) {
	registry[kind] = kindSpec{state: state, newConfig: newConfig}
}

func Known(kind string) bool {
	_, ok := registry[kind]
	return ok
}

// ParseConfig validates a raw config document against the kind's struct.
func ParseConfig(kind string, raw []byte) ([]byte, error) {
	spec, ok := registry[kind]
	if !ok {
		return nil, fmt.Errorf("unknown session kind %q", kind)
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	cfg := spec.newConfig()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(cfg); err != nil {
		return nil, err
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
}

func roster(ctx context.Context, pool *pgxpool.Pool, spaceID string) (string, []Person, error) {
	var slug string
	if err := pool.QueryRow(ctx, "select slug from spaces where id = $1", spaceID).Scan(&slug); err != nil {
		return "", nil, err
	}
	rows, err := pool.Query(ctx, `
		select m.user_id::text, u.name, m.spectator
		from members m join users u on u.id = m.user_id
		where m.space_id = $1 order by u.name`, spaceID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	people := []Person{}
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.UserID, &p.Name, &p.Spectator); err != nil {
			return "", nil, err
		}
		p.AvatarHue = store.AvatarHue(p.UserID)
		people = append(people, p)
	}
	return slug, people, rows.Err()
}

func BuildEnvelope(ctx context.Context, pool *pgxpool.Pool, h *hub.Hub, sessions *store.Sessions, id string) (Envelope, error) {
	sess, err := sessions.ByID(ctx, id)
	if err != nil {
		return Envelope{}, err
	}
	spec, ok := registry[sess.Kind]
	if !ok {
		return Envelope{}, fmt.Errorf("unknown session kind %q", sess.Kind)
	}
	state, err := spec.state(ctx, pool, sess)
	if err != nil {
		return Envelope{}, err
	}
	slug, people, err := roster(ctx, pool, sess.SpaceID)
	if err != nil {
		return Envelope{}, err
	}

	presence := h.Connected(id)
	facConnected := false
	for _, uid := range presence {
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
		Presence:             presence,
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
