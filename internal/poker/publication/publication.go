// Package publication records reviewed split handoffs. It has no production
// adapter or HTTP route; a verified host provider is required for dispatch.
package publication

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Scope struct{ OrgID, SpaceID, SessionID, PrincipalID string }
type Capability struct {
	Verified                                                                 bool
	Generation, Destination, IssueType, ParentID, ParentDisposition, FieldID string
	Mapping                                                                  map[string]string
}
type Request struct {
	ParentID    string
	Children    []string
	Fingerprint string
}
type Step struct {
	Key               string     `json:"key"`
	Kind              string     `json:"kind"`
	ChildID           string     `json:"childId,omitempty"`
	BlockerID         string     `json:"blockerId,omitempty"`
	DependentID       string     `json:"dependentId,omitempty"`
	EdgeID            string     `json:"edgeId,omitempty"`
	Value             string     `json:"value,omitempty"`
	Body              string     `json:"body,omitempty"`
	DispatchAttempt   int        `json:"-"`
	PreviousOutcome   Outcome    `json:"-"`
	Title             string     `json:"title,omitempty"`
	Notes             string     `json:"notes,omitempty"`
	RemoteID          string     `json:"remoteId,omitempty"`
	BlockerRemoteID   string     `json:"blockerRemoteId,omitempty"`
	DependentRemoteID string     `json:"dependentRemoteId,omitempty"`
	Waiting           bool       `json:"waiting,omitempty"`
	TargetKey         string     `json:"targetKey"`
	PairKey           string     `json:"pairKey,omitempty"`
	Binding           Capability `json:"binding"`
}
type Review struct {
	ID, Fingerprint string
	PrincipalID     string `json:"-"`
	Binding         Capability
	Steps           []Step
}
type Outcome string

const (
	Local     Outcome = "local-only"
	Waiting   Outcome = "waiting-for-issues"
	Pending   Outcome = "pending"
	Confirmed Outcome = "confirmed"
	Failed    Outcome = "failed"
	Unknown   Outcome = "unknown"
)

type Receipt struct {
	Key         string  `json:"key"`
	Kind        string  `json:"kind"`
	State       Outcome `json:"state"`
	RemoteID    string  `json:"remoteId,omitempty"`
	Attempts    int     `json:"attempts"`
	ChildID     string  `json:"childId,omitempty"`
	EdgeID      string  `json:"edgeId,omitempty"`
	BlockerID   string  `json:"blockerId,omitempty"`
	DependentID string  `json:"dependentId,omitempty"`
}
type Observation struct {
	Known, Matches  bool
	MutationAllowed bool
	RemoteID        string
}

// Inspect reports Known only after definitive operation-identity/pair readback.
// MutationAllowed requires current write permission and, for estimates, the
// approved remote baseline. A successful read cannot itself grant write consent.
// Capability is a bounded host-authority check, not an unbounded network probe.
type Provider interface {
	Capability(context.Context, Scope) (Capability, error)
	Inspect(context.Context, Scope, Step) (Observation, error)
	Apply(context.Context, Scope, Step) (Outcome, error)
}
type Engine struct {
	Pool     *pgxpool.Pool
	Provider Provider
}

var ErrPaused = errors.New("publication paused; review current authority and split")
