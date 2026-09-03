package plugin

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
)

// Installs belong to an org, and the administration surface reaches them
// through an Admin rather than through the Store.
//
// The Store's own methods take an install id and nothing else, because the
// host calls them on behalf of a plugin that is already running and has
// already been resolved. The operator routes are the opposite case: the id
// arrives in a URL somebody typed, and the only thing the middleware in front
// of them proves is that the caller administers the org named in *their own*
// path. Resolving that id against every install on the instance is what let an
// admin of one org uninstall another org's plugin, so the id is never resolved
// that way here: every lookup carries the org, and an install belonging to
// somebody else resolves to nothing at all.
//
// Nothing at all, rather than a refusal, is the deliberate part. A foreign id
// and an id that was never issued return the same ErrNoSuchInstall and the same
// 404, so the surface cannot be used to learn which ids exist in other orgs.

// ErrNoSuchInstall is returned for an install id this org does not own — which
// includes an id that does not exist anywhere. The two are indistinguishable on
// purpose.
var ErrNoSuchInstall = errors.New("no such plugin install")

// Admin is a Store scoped to one org.
type Admin struct {
	s     *Store
	orgID string
}

// InOrg scopes a store to one org's installs.
func (s *Store) InOrg(orgID string) *Admin { return &Admin{s: s, orgID: orgID} }

// Unscoped is the underlying store, for the reads that are not about one
// install — whether secrets are available at all, and so on.
func (a *Admin) Unscoped() *Store { return a.s }

var uuidLike = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// own resolves an install id inside this org. It is the guard: every method
// below calls it before it touches anything, and the mutating statements carry
// the org id a second time so that breaking either one is caught.
func (a *Admin) own(ctx context.Context, installID string) error {
	// A malformed id is not a database error to report, it is an id that was
	// never issued — same answer as a foreign one.
	if !uuidLike.MatchString(installID) {
		return ErrNoSuchInstall
	}
	var got string
	err := a.s.Pool.QueryRow(ctx,
		`select id from plugin_installs where id = $1 and org_id = $2`, installID, a.orgID).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNoSuchInstall
	}
	if err != nil {
		return fmt.Errorf("resolving install %s: %w", installID, err)
	}
	return nil
}

// Installs lists this org's install ids, in name order.
func (a *Admin) Installs(ctx context.Context) ([]string, error) {
	rows, err := a.s.Pool.Query(ctx,
		`select id from plugin_installs where org_id = $1 order by name`, a.orgID)
	if err != nil {
		return nil, fmt.Errorf("listing installs: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("reading an install id: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// State reads one of this org's installs.
func (a *Admin) State(ctx context.Context, installID string) (State, error) {
	if err := a.own(ctx, installID); err != nil {
		return State{}, err
	}
	return a.s.State(ctx, installID)
}

// ByName finds this org's install of a plugin. A name is unique inside an org
// and not across the instance, so another org running the same plugin is not
// this org's install of it.
func (a *Admin) ByName(ctx context.Context, name string) (State, bool, error) {
	var id string
	err := a.s.Pool.QueryRow(ctx,
		`select id from plugin_installs where org_id = $1 and name = $2`, a.orgID, name).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, fmt.Errorf("looking up install %q: %w", name, err)
	}
	state, err := a.s.State(ctx, id)
	if err != nil {
		return State{}, false, err
	}
	return state, true, nil
}

// Install records a plugin against this org.
func (a *Admin) Install(ctx context.Context, req InstallRequest) (Install, error) {
	req.OrgID = a.orgID
	return a.s.Install(ctx, req)
}

// Upgrade moves one of this org's installs to a new version.
func (a *Admin) Upgrade(ctx context.Context, installID, version string, want []Grant) error {
	if err := a.own(ctx, installID); err != nil {
		return err
	}
	return a.s.Upgrade(ctx, installID, version, want)
}

// Pending returns the upgrade waiting on this org's operator.
func (a *Admin) Pending(ctx context.Context, installID string) (PendingUpgrade, bool, error) {
	if err := a.own(ctx, installID); err != nil {
		return PendingUpgrade{}, false, err
	}
	return a.s.Pending(ctx, installID)
}

// ApproveUpgrade puts a wider grant set into force for one of this org's
// installs.
func (a *Admin) ApproveUpgrade(ctx context.Context, installID string) error {
	if err := a.own(ctx, installID); err != nil {
		return err
	}
	return a.s.ApproveUpgrade(ctx, installID)
}

// SetEnabled turns one of this org's installs on or off.
func (a *Admin) SetEnabled(ctx context.Context, installID string, enabled bool) error {
	if err := a.own(ctx, installID); err != nil {
		return err
	}
	return a.s.setEnabled(ctx, a.orgID, installID, enabled)
}

// BlockingSessions lists the kinds one of this org's installs provides that
// still have sessions.
func (a *Admin) BlockingSessions(ctx context.Context, installID string) ([]BlockingKind, error) {
	if err := a.own(ctx, installID); err != nil {
		return nil, err
	}
	return a.s.BlockingSessions(ctx, installID)
}

// Uninstall destroys one of this org's installs. See Store.uninstall for what
// that means and why it is one transaction.
func (a *Admin) Uninstall(ctx context.Context, installID string, inTx TxHook) error {
	if err := a.own(ctx, installID); err != nil {
		return err
	}
	return a.s.uninstall(ctx, a.orgID, installID, inTx)
}
