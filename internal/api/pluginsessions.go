package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/lets-parley/parley/internal/store"
)

// The live session surface a plugin sees.
//
// This is the first time WASM code can read a room's state, so what it can see
// is decided here rather than by the plugin's grant alone. Two rules, and both
// are guards a mutation test breaks:
//
//   - A plugin reads through the same envelope a browser is sent, built by the
//     session registry, so its kind's StateFunc has already redacted the
//     payload. It is a projection, not a filter: poker's pre-reveal state emits
//     who has voted and never the value, so there is no hidden field for a
//     plugin to reach past. A plugin therefore cannot learn anything a member
//     of the room could not.
//   - A plugin can only reach rooms in its own org. An install belongs to one
//     org (0034) and so does the kind it provides (0035); a session id from
//     another org answers the same "no such session" as one that does not
//     exist, so the surface cannot be used to discover other orgs' rooms.
//   - A plugin can only reach rooms running a ceremony it provides. The org
//     boundary alone is not enough and it is worth being blunt about why: the
//     human reveal is a facilitator-only action, and a plugin patching
//     {"revealed": true} on a poker room in its own org would walk straight
//     past that check and turn every hidden vote in the room into a readable
//     one. A grant does not save it either — an unscoped session:patch means
//     "any session id", so consent could not narrow this even if an operator
//     wanted to. The boundary has to be structural, so it is: an install
//     reaches its own ceremonies and nothing else, and a core kind (provider
//     'core', no org) is provided by no install and so is closed to every
//     plugin on the instance.
type pluginSessions struct{ app *app }

// errForeignSession is the refusal for a session outside the install's org, for
// one running a kind the install does not provide, and for one that does not
// exist. They are deliberately the same answer.
var errForeignSession = errors.New("no such session")

// ownSession resolves a session the install is allowed to touch. It is the
// guard: both host functions call it before anything else.
func (p *pluginSessions) ownSession(ctx context.Context, installID, sessionID string) (store.Session, error) {
	state, err := p.app.plugins.State(ctx, installID)
	if err != nil {
		return store.Session{}, err
	}
	sess, err := p.app.sessions.ByID(ctx, sessionID)
	if errors.Is(err, store.ErrNoSession) {
		return store.Session{}, errForeignSession
	}
	if err != nil {
		return store.Session{}, err
	}
	org, err := p.app.orgs.BySpaceID(ctx, sess.SpaceID)
	if err != nil {
		return store.Session{}, err
	}
	if !sameOrg(org.ID, state.Install.OrgID) {
		return store.Session{}, errForeignSession
	}
	provides, err := p.app.plugins.ProvidesKind(ctx, installID, sess.Kind)
	if err != nil {
		return store.Session{}, err
	}
	if !ownsKind(provides) {
		return store.Session{}, errForeignSession
	}
	return sess, nil
}

// sameOrg is the org boundary itself, as one function so that breaking it
// breaks it everywhere and so that the mutation harness has something to
// break. An install belongs to one org and may only ever reach that org's
// rooms.
func sameOrg(sessionOrgID, installOrgID string) bool { return sessionOrgID == installOrgID }

// ownsKind is the kind-ownership boundary, kept as its own function for the
// same two reasons sameOrg is: one place to break, one place to read. The
// argument is Store.ProvidesKind's answer — whether the session_kinds row for
// this room names this install as its provider.
func ownsKind(installProvidesTheKind bool) bool { return installProvidesTheKind }

// Read returns the room's state as the browser gets it: redacted by the kind's
// own StateFunc, which is the only place that decides what is client-safe.
func (p *pluginSessions) Read(ctx context.Context, installID, sessionID string) ([]byte, error) {
	sess, err := p.ownSession(ctx, installID, sessionID)
	if err != nil {
		return nil, err
	}
	env, err := p.app.kinds.BuildEnvelope(ctx, p.app.pool, p.app.presence, p.app.sessions, sess.ID)
	if err != nil {
		return nil, fmt.Errorf("building the state of session %s for a plugin: %w", sessionID, err)
	}
	return json.Marshal(env)
}

// sessionPatch is everything a plugin may change about a room through this
// surface. It is a closed document on purpose: a plugin owns its own state in
// its key-value store, and what it needs from the core is the shared phase and
// the reveal every kind has. Anything else — the title, who facilitates,
// whether the room has ended — belongs to a person, and unknown fields are
// refused rather than ignored so a plugin is told it asked for something that
// does not exist.
type sessionPatch struct {
	Phase    *string `json:"phase"`
	Revealed *bool   `json:"revealed"`
}

// maxPhase is the phase column's own bound. A plugin's phase is its own word,
// but an unbounded one is a write amplifier.
const maxPhase = 64

func (p *pluginSessions) Patch(ctx context.Context, installID, sessionID string, patch []byte) error {
	sess, err := p.ownSession(ctx, installID, sessionID)
	if err != nil {
		return err
	}
	var doc sessionPatch
	dec := json.NewDecoder(bytes.NewReader(patch))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		return fmt.Errorf("reading the patch for session %s: %w", sessionID, err)
	}
	if doc.Phase != nil && (*doc.Phase == "" || len(*doc.Phase) > maxPhase) {
		return fmt.Errorf("a phase must be 1-%d characters", maxPhase)
	}
	// An ended room is closed to writes from a plugin exactly as it is closed
	// to writes from a person: the dispatcher answers 409 for every action of
	// every kind, and a host function is not a way around it.
	tag, err := p.app.pool.Exec(ctx, `
		update sessions
		set phase = coalesce($2, phase), revealed = coalesce($3, revealed), version = version + 1
		where id = $1 and ended_at is null`, sess.ID, doc.Phase, doc.Revealed)
	if err != nil {
		return fmt.Errorf("patching session %s: %w", sessionID, err)
	}
	if tag.RowsAffected() == 0 {
		return store.ErrSessionEnded
	}
	p.app.broadcastState(ctx, sess.ID)
	return nil
}
