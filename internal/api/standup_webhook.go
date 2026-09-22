package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/netip"
	"net/url"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/plugin"
)

// guardedWebhookSend posts a delivery through the plugin fetch guard: https
// only, the host on the operator's STANDUP_WEBHOOK_HOSTS, resolved once,
// every record screened, the screened address dialled. A redirect is not
// followed; the 3xx is the attempt's result.
func guardedWebhookSend(f *plugin.Fetcher, hosts []string) func(context.Context, string, map[string]string, []byte) (int, error) {
	return func(ctx context.Context, u string, headers map[string]string, body []byte) (int, error) {
		return f.PostNoFollow(ctx, hosts, u, headers, body)
	}
}

func (a *app) webhookUnconfigured(w http.ResponseWriter) bool {
	if a.webhooks != nil {
		return false
	}
	http.Error(w, `{"error":"standup webhooks need PLUGIN_SECRET_KEY set on this instance, so the signing secret can be stored encrypted"}`, http.StatusServiceUnavailable)
	return true
}

func (a *app) handleGetStandupWebhook(w http.ResponseWriter, r *http.Request) {
	if a.webhookUnconfigured(w) {
		return
	}
	u, ok, err := a.webhooks.Get(r.Context(), spaceFrom(r.Context()).ID)
	if err != nil {
		http.Error(w, `{"error":"could not load the standup webhook"}`, http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"url": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": u})
}

// handlePutStandupWebhook sets the space's webhook and mints a new signing
// secret. The secret is in this response and nowhere else, ever.
func (a *app) handlePutStandupWebhook(w http.ResponseWriter, r *http.Request) {
	if a.webhookUnconfigured(w) {
		return
	}
	var in struct {
		URL string `json:"url"`
	}
	if err := decodeStandupSchedule(w, r, &in); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	u, err := url.Parse(in.URL)
	switch {
	case err != nil || u.Scheme != "https" || u.Host == "":
		http.Error(w, `{"error":"the webhook url must be an https url"}`, http.StatusBadRequest)
		return
	case u.User != nil:
		http.Error(w, `{"error":"the webhook url must not carry a username or password"}`, http.StatusBadRequest)
		return
	}
	if _, err := netip.ParseAddr(u.Hostname()); err == nil {
		http.Error(w, `{"error":"the webhook url must name a host, not an ip address"}`, http.StatusBadRequest)
		return
	}
	if !plugin.HostAllowed(u.Hostname(), a.webhookHosts) {
		http.Error(w, `{"error":"that host is not on this instance's webhook allowlist; the operator sets STANDUP_WEBHOOK_HOSTS"}`, http.StatusBadRequest)
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		http.Error(w, `{"error":"could not generate a signing secret"}`, http.StatusInternalServerError)
		return
	}
	secret := hex.EncodeToString(raw)
	p, _ := PrincipalFrom(r.Context())
	if err := a.webhooks.Put(r.Context(), spaceFrom(r.Context()).ID, p.UserID, u.String(), secret); err != nil {
		http.Error(w, `{"error":"could not save the standup webhook"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": u.String(), "secret": secret})
}

func (a *app) handleDeleteStandupWebhook(w http.ResponseWriter, r *http.Request) {
	if a.webhookUnconfigured(w) {
		return
	}
	if err := a.webhooks.Delete(r.Context(), spaceFrom(r.Context()).ID); err != nil {
		http.Error(w, `{"error":"could not remove the standup webhook"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
