package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/plugin"
)

// jiraFieldID is the only field id this phase accepts. The screen does not
// invent one, and a label such as "Story points" is not a field id.
var jiraFieldID = regexp.MustCompile(`^customfield_[0-9]+$`)

var errJiraSecretRequired = errors.New("a client secret is required")

// jiraConnectionView is what an org admin may see. The client id, the client
// secret, and the sealed columns are not on it.
type jiraConnectionView struct {
	Configured   bool   `json:"configured"`
	CloudID      string `json:"cloudId,omitempty"`
	FieldID      string `json:"fieldId,omitempty"`
	Generation   string `json:"generation,omitempty"`
	SecretStored bool   `json:"secretStored,omitempty"`
}

type jiraWriteView struct {
	Configured   bool `json:"configured"`
	WriteEnabled bool `json:"writeEnabled"`
}

func (a *app) jiraUnconfigured(w http.ResponseWriter) bool {
	if a.plugins != nil && a.plugins.Cipher != nil {
		return false
	}
	http.Error(w, `{"error":"jira connections need PLUGIN_SECRET_KEY set on this instance, so the client secret can be stored encrypted"}`, http.StatusServiceUnavailable)
	return true
}

func (a *app) handleGetJiraConnection(w http.ResponseWriter, r *http.Request) {
	if a.jiraUnconfigured(w) {
		return
	}
	view, err := a.loadJiraConnection(r.Context(), orgFrom(r.Context()).ID)
	if err != nil {
		slog.Error("jira connection", "error", err)
		http.Error(w, `{"error":"could not load the jira connection"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) handlePutJiraConnection(w http.ResponseWriter, r *http.Request) {
	if a.jiraUnconfigured(w) {
		return
	}
	var in struct {
		CloudID      string `json:"cloudId"`
		FieldID      string `json:"fieldId"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &in); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	if !validJiraCloudID(in.CloudID) {
		http.Error(w, `{"error":"cloud id is required"}`, http.StatusBadRequest)
		return
	}
	if !jiraFieldID.MatchString(in.FieldID) || len(in.FieldID) > 64 {
		http.Error(w, `{"error":"field id must be customfield_ followed by digits"}`, http.StatusBadRequest)
		return
	}
	if !validJiraClientID(in.ClientID) {
		http.Error(w, `{"error":"client id is required"}`, http.StatusBadRequest)
		return
	}
	if in.ClientSecret != "" && !validJiraSecret(in.ClientSecret) {
		http.Error(w, `{"error":"client secret must be a single line"}`, http.StatusBadRequest)
		return
	}
	orgID := orgFrom(r.Context()).ID
	if err := a.saveJiraConnection(r.Context(), orgID, in.CloudID, in.FieldID, in.ClientID, in.ClientSecret); err != nil {
		if errors.Is(err, errJiraSecretRequired) {
			http.Error(w, `{"error":"a client secret is required"}`, http.StatusBadRequest)
			return
		}
		slog.Error("jira connection", "error", err)
		http.Error(w, `{"error":"could not save the jira connection"}`, http.StatusInternalServerError)
		return
	}
	view, err := a.loadJiraConnection(r.Context(), orgID)
	if err != nil {
		slog.Error("jira connection", "error", err)
		http.Error(w, `{"error":"could not load the jira connection"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) handleGetJiraWrite(w http.ResponseWriter, r *http.Request) {
	view, err := a.jiraWriteView(r.Context())
	if err != nil {
		slog.Error("jira write", "error", err)
		http.Error(w, `{"error":"could not load jira write-back"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (a *app) handlePutJiraWrite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		WriteEnabled bool `json:"writeEnabled"`
	}
	if err := decodeJiraWrite(w, r, &in); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	orgID := orgFrom(r.Context()).ID
	spaceID := spaceFrom(r.Context()).ID
	if in.WriteEnabled {
		view, err := a.loadJiraConnection(r.Context(), orgID)
		if err != nil {
			slog.Error("jira write", "error", err)
			http.Error(w, `{"error":"could not load jira write-back"}`, http.StatusInternalServerError)
			return
		}
		if !view.Configured {
			http.Error(w, `{"error":"an org admin adds the jira credential before a space can turn write-back on"}`, http.StatusBadRequest)
			return
		}
	}
	tag, err := a.pool.Exec(r.Context(),
		`update spaces set jira_write_enabled = $1 where id = $2 and org_id = $3`,
		in.WriteEnabled, spaceID, orgID)
	if err != nil || tag.RowsAffected() != 1 {
		slog.Error("jira write", "error", err)
		http.Error(w, `{"error":"could not save jira write-back"}`, http.StatusInternalServerError)
		return
	}
	view, err := a.jiraWriteView(r.Context())
	if err != nil {
		slog.Error("jira write", "error", err)
		http.Error(w, `{"error":"could not load jira write-back"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// decodeJiraWrite refuses any field other than writeEnabled, so a connection
// id in the body cannot select a row.
func decodeJiraWrite(w http.ResponseWriter, r *http.Request, into any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, httprequest.MaxJSONBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return err
	}
	return fmt.Errorf("request body contains more than one JSON document")
}

func (a *app) jiraWriteView(ctx context.Context) (jiraWriteView, error) {
	orgID := orgFrom(ctx).ID
	conn, err := a.loadJiraConnection(ctx, orgID)
	if err != nil {
		return jiraWriteView{}, err
	}
	var on bool
	if err := a.pool.QueryRow(ctx,
		`select jira_write_enabled from spaces where id = $1 and org_id = $2`,
		spaceFrom(ctx).ID, orgID).Scan(&on); err != nil {
		return jiraWriteView{}, fmt.Errorf("reading jira write-back: %w", err)
	}
	if !conn.Configured {
		on = false
	}
	return jiraWriteView{Configured: conn.Configured, WriteEnabled: on}, nil
}

// loadJiraConnection reads the connection for the request org. orgID comes
// from orgFrom; a client-supplied org id is never used. No row is an empty
// view, the same answer as a row that belongs to someone else.
func (a *app) loadJiraConnection(ctx context.Context, orgID string) (jiraConnectionView, error) {
	var view jiraConnectionView
	err := a.pool.QueryRow(ctx, `
		select cloud_id, field_id, generation::text
		from jira_connections where org_id = $1`, orgID).Scan(&view.CloudID, &view.FieldID, &view.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return jiraConnectionView{}, nil
	}
	if err != nil {
		return jiraConnectionView{}, fmt.Errorf("reading jira connection: %w", err)
	}
	view.Configured = true
	view.SecretStored = true
	return view, nil
}

// saveJiraConnection seals the client secret to the connection id and the
// request org, then upserts that one row. An empty secret on an existing row
// leaves the sealed bytes alone. The connection id is chosen before Seal so
// the additional data names the row that will hold the ciphertext.
func (a *app) saveJiraConnection(ctx context.Context, orgID, cloudID, fieldID, clientID, secret string) error {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("starting a jira connection write: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "lock table secret_binding in share mode"); err != nil {
		return fmt.Errorf("locking the secret binding marker: %w", err)
	}
	if _, err := tx.Exec(ctx, "lock table jira_connections in share row exclusive mode"); err != nil {
		return fmt.Errorf("locking jira connections: %w", err)
	}
	var id, keyID string
	var nonce, ciphertext []byte
	err = tx.QueryRow(ctx, `
		select id::text, nonce, ciphertext, key_id
		from jira_connections where org_id = $1`, orgID).Scan(&id, &nonce, &ciphertext, &keyID)
	if errors.Is(err, pgx.ErrNoRows) {
		if secret == "" {
			return errJiraSecretRequired
		}
		if err := tx.QueryRow(ctx, "select gen_random_uuid()::text").Scan(&id); err != nil {
			return fmt.Errorf("generating a jira connection id: %w", err)
		}
		nonce, ciphertext, keyID = nil, nil, ""
	} else if err != nil {
		return fmt.Errorf("reading jira connection: %w", err)
	}
	if secret != "" {
		nonce, ciphertext, keyID, err = a.plugins.Cipher.Seal(plugin.JiraSecretAAD(id, orgID), secret)
		if err != nil {
			return fmt.Errorf("sealing the jira client secret: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
		insert into jira_connections (id, org_id, cloud_id, field_id, client_id, generation, nonce, ciphertext, key_id)
		values ($1, $2, $3, $4, $5, gen_random_uuid(), $6, $7, $8)
		on conflict (org_id) do update set
			cloud_id = excluded.cloud_id,
			field_id = excluded.field_id,
			client_id = excluded.client_id,
			generation = gen_random_uuid(),
			nonce = excluded.nonce,
			ciphertext = excluded.ciphertext,
			key_id = excluded.key_id`,
		id, orgID, cloudID, fieldID, clientID, nonce, ciphertext, keyID); err != nil {
		return fmt.Errorf("storing jira connection: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("storing jira connection: %w", err)
	}
	return nil
}

func validJiraCloudID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

func validJiraClientID(s string) bool {
	if s == "" || len(s) > 256 {
		return false
	}
	for _, r := range s {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

func validJiraSecret(s string) bool {
	if s == "" || len(s) > 4096 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
