package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/lets-parley/parley/internal/plugin"
	"github.com/lets-parley/parley/internal/plugin/bundle"
	"github.com/lets-parley/parley/internal/store"
)

// The instance plugin catalogue: signed bundles stored once for every org.
//
// Uploading is an instance-wide act, so it belongs to the default org's
// admins — the curators — and to nobody else, whatever they administer.
// Browsing is open to anyone who belongs to at least one org, because every
// org admin chooses from it; the projection they read names no uploader, no
// org and no install count.

const (
	bundleContentType = "application/vnd.parley.bundle"
	bundleUploadPath  = "/api/catalogue/bundles"
)

// isBundleUpload is the one request requireJSONBody lets through without a
// JSON body, and limitAPIRequestBody lets past its JSON cap. It is an exact
// method, path and type match, never a prefix: a matching rule that grew a
// wildcard would exempt routes nobody meant to. The type is not a
// CORS-safelisted one, so a cross-site page cannot send it without a
// preflight, and rejectCrossSite still runs ahead of the exemption.
func isBundleUpload(r *http.Request) bool {
	return r.Method == http.MethodPost && r.URL.Path == bundleUploadPath &&
		r.Header.Get("Content-Type") == bundleContentType
}

// requireInstanceCurator admits a default-org admin and nobody else. It runs
// behind RequireUser and reads no URL parameter: the org is always the default
// one, so an admin of any other org is refused 403 here. The membership is
// re-read on every request, so a revocation takes effect at once. It puts the
// default org in the context, so the audit row names it.
func (a *app) requireInstanceCurator(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := PrincipalFrom(r.Context())
		if !ok {
			http.Error(w, `{"error":"not signed in"}`, http.StatusUnauthorized)
			return
		}
		org, curator, err := a.curator(r.Context(), p)
		if err != nil {
			http.Error(w, `{"error":"could not load org"}`, http.StatusInternalServerError)
			return
		}
		if !curator {
			http.Error(w, `{"error":"only an admin of the default org can manage the plugin catalogue"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), orgKey{}, org)))
	})
}

// curator reports whether p is a non-revoked admin of the default org. An
// embedded session is never one, whoever holds it.
func (a *app) curator(ctx context.Context, p Principal) (store.Org, bool, error) {
	if p.Embedded || p.UserID == "" {
		return store.Org{}, false, nil
	}
	org, err := a.org(ctx)
	if err != nil {
		return store.Org{}, false, err
	}
	role, err := a.orgs.RoleOf(ctx, org.ID, p.UserID)
	if errors.Is(err, store.ErrNotOrgMember) {
		return org, false, nil
	}
	if err != nil {
		return org, false, err
	}
	return org, role == store.OrgRoleAdmin, nil
}

// catalogueVersion is one stored bundle as the catalogue shows it. Its digest
// and key id together name exactly one row, and are what an install names.
type catalogueVersion struct {
	Version  string                  `json:"version"`
	Digest   string                  `json:"digest"`
	KeyID    string                  `json:"key_id"`
	Grants   []plugin.DescribedGrant `json:"grants"`
	Settings json.RawMessage         `json:"settings,omitempty"`
}

type cataloguePlugin struct {
	Name     string             `json:"name"`
	Versions []catalogueVersion `json:"versions"`
}

type catalogueView struct {
	CanUpload bool              `json:"can_upload"`
	Plugins   []cataloguePlugin `json:"plugins"`
}

// project builds a version's view from its manifest alone. The capability
// copy comes from describe.go, never from anything the bundle wrote.
func project(version, digest, keyID string, manifest []byte) catalogueVersion {
	var m struct {
		pluginPackage
		Settings json.RawMessage `json:"settings"`
	}
	_ = json.Unmarshal(manifest, &m)
	return catalogueVersion{
		Version: version, Digest: digest, KeyID: keyID,
		Grants: plugin.DescribeAll(m.grants()), Settings: m.Settings,
	}
}

func (a *app) handleCatalogue(w http.ResponseWriter, r *http.Request) {
	p, _ := PrincipalFrom(r.Context())
	orgs, err := a.orgs.ForUser(r.Context(), p.UserID)
	if err != nil {
		http.Error(w, `{"error":"could not load the catalogue"}`, http.StatusInternalServerError)
		return
	}
	if len(orgs) == 0 {
		http.Error(w, `{"error":"the catalogue is open to members of an org"}`, http.StatusForbidden)
		return
	}
	_, curator, err := a.curator(r.Context(), p)
	if err != nil {
		http.Error(w, `{"error":"could not load the catalogue"}`, http.StatusInternalServerError)
		return
	}
	view := catalogueView{CanUpload: curator, Plugins: []cataloguePlugin{}}
	rows, err := a.pool.Query(r.Context(), `
		select name, version, digest, key_id, manifest from plugin_bundles
		order by name, uploaded_at desc, key_id desc`)
	if err != nil {
		http.Error(w, `{"error":"could not load the catalogue"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var name, version, digest, keyID string
		var manifest []byte
		if err := rows.Scan(&name, &version, &digest, &keyID, &manifest); err != nil {
			http.Error(w, `{"error":"could not load the catalogue"}`, http.StatusInternalServerError)
			return
		}
		if n := len(view.Plugins); n == 0 || view.Plugins[n-1].Name != name {
			view.Plugins = append(view.Plugins, cataloguePlugin{Name: name})
		}
		last := &view.Plugins[len(view.Plugins)-1]
		last.Versions = append(last.Versions, project(version, digest, keyID, manifest))
	}
	if rows.Err() != nil {
		http.Error(w, `{"error":"could not load the catalogue"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// signatureRefusals are the verification failures about who signed a bundle,
// as opposed to how it was packed. They are security events.
var signatureRefusals = []error{bundle.ErrBadSignature, bundle.ErrUntrustedKey, bundle.ErrUnsigned}

var packingRefusals = []error{
	bundle.ErrUnlisted, bundle.ErrMissing, bundle.ErrDigestMismatch, bundle.ErrPath,
	bundle.ErrNotRegular, bundle.ErrDuplicate, bundle.ErrUnknownFile, bundle.ErrWasmTooLarge,
	bundle.ErrTooLarge, bundle.ErrMalformed,
}

func isAny(err error, targets []error) bool {
	for _, t := range targets {
		if errors.Is(err, t) {
			return true
		}
	}
	return false
}

func (a *app) handleUploadBundle(w http.ResponseWriter, r *http.Request) {
	if !isBundleUpload(r) {
		http.Error(w, `{"error":"Content-Type must be `+bundleContentType+`"}`, http.StatusUnsupportedMediaType)
		return
	}
	if a.bundles == nil || a.bundles.Pool == nil {
		http.Error(w, `{"error":"the plugin catalogue is not available on this instance"}`, http.StatusServiceUnavailable)
		return
	}
	// limitAPIRequestBody passes this body through unread, so this is its
	// only cap, and it runs only behind requireInstanceCurator.
	archive, err := io.ReadAll(http.MaxBytesReader(w, r.Body, bundle.MaxUpload))
	if err != nil {
		http.Error(w, `{"error":"the bundle is too large"}`, http.StatusRequestEntityTooLarge)
		return
	}
	p, _ := PrincipalFrom(r.Context())
	b, added, err := a.bundles.Add(r.Context(), archive, auditActor(p))
	switch {
	case err == nil:
	case errors.Is(err, plugin.ErrBundleConflict):
		http.Error(w, `{"error":"another bundle already holds this plugin name and version"}`, http.StatusConflict)
		return
	case isAny(err, signatureRefusals):
		// Audited: a refused signature is somebody trying to put code on
		// every org's shelf that this instance does not trust. No bytes and
		// no error text from the bundle are recorded.
		a.auditPlugin(r, "plugin.catalogue.refused", "a bundle's signature did not verify against a trusted key")
		http.Error(w, `{"error":"the bundle is not signed by a key this instance trusts"}`, http.StatusUnprocessableEntity)
		return
	case isAny(err, packingRefusals), errors.Is(err, plugin.ErrBundleIdentity):
		http.Error(w, `{"error":"the bundle is not a valid parley bundle"}`, http.StatusBadRequest)
		return
	default:
		slog.Error("storing a catalogue bundle", "error", err)
		http.Error(w, `{"error":"could not store the bundle"}`, http.StatusInternalServerError)
		return
	}
	name, version, _ := manifestIdentity(b.Manifest)
	out := cataloguePlugin{Name: name, Versions: []catalogueVersion{project(version, b.Digest, b.KeyID, b.Manifest)}}
	// The identical bundle again is not an error, but nothing was added:
	// 200, and no audit row for a write that did not happen.
	if !added {
		writeJSON(w, http.StatusOK, out)
		return
	}
	a.auditPlugin(r, "plugin.catalogue.upload", name+" "+version+" "+b.Digest+"/"+b.KeyID)
	writeJSON(w, http.StatusCreated, out)
}

func manifestIdentity(manifest []byte) (string, string, error) {
	var m struct{ Name, Version string }
	err := json.Unmarshal(manifest, &m)
	return m.Name, m.Version, err
}
