package standup

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/lets-parley/parley/internal/httprequest"
	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

// maxKudoChars mirrors internal/api/kudos.go and the check in 0033_kudos.sql.
// Characters, not bytes, for the reason putEntry counts characters.
const maxKudoChars = 280

// giveKudo thanks somebody by name at the end of a round. The kudo is written
// to the one kudos table with this session on it, so it is on the space's wall
// the moment it is given — there is no second store and no second read path.
//
// The membership check is here, and deliberately so. Every other guard a
// standup action gets for free runs in the core dispatcher, which applies
// FacilitatorOnly and the ended-session guard and nothing else; there is no
// link flag on session.Action, and rosterUsers above unions link guests into
// the round on purpose. So "guests neither send nor receive" has nowhere else
// in this path to live. The store asserts it a second time under the space
// lock, where it also catches a recipient — that one stays: this check is the
// boundary's, that one is the table's.
func giveKudo(w http.ResponseWriter, r *http.Request, ac session.ActionCtx) {
	var body struct {
		To   string `json:"to"`
		Text string `json:"text"`
	}
	if err := httprequest.DecodeJSON(w, r, httprequest.MaxJSONBody, &body); err != nil {
		httprequest.WriteDecodeError(w, err, `{"error":"invalid JSON body"}`)
		return
	}
	text := strings.TrimSpace(body.Text)
	if body.To == "" {
		http.Error(w, `{"error":"who is this for?"}`, http.StatusBadRequest)
		return
	}
	if text == "" || utf8.RuneCountInString(text) > maxKudoChars {
		http.Error(w, `{"error":"a kudo is between 1 and 280 characters"}`, http.StatusBadRequest)
		return
	}

	err := (&store.Sessions{Pool: ac.Pool}).WithActiveSession(r.Context(), ac.Session.ID, ac.UserID, false,
		func(tx pgx.Tx, sess store.Session) error {
			var member bool
			if err := tx.QueryRow(r.Context(),
				"select exists (select 1 from members where space_id = $1 and user_id = $2)",
				sess.SpaceID, ac.UserID).Scan(&member); err != nil {
				return err
			}
			if !member {
				return errNotAMember
			}
			if _, err := (&store.Kudos{Pool: ac.Pool}).CreateIn(r.Context(), tx,
				sess.SpaceID, ac.UserID, body.To, text, sess.ID, ac.KudoLimit); err != nil {
				return err
			}
			return bumpVersion(r, tx, sess)
		})
	if err != nil {
		writeKudoError(w, err)
		return
	}
	done(w, r, ac)
}

// errNotAMember is a caller who is in the room but not on the roster — a link
// guest. It is the action's own refusal, distinct from the store's
// ErrNotAMember, which speaks for both parties.
var errNotAMember = errors.New("only a member of this space can give a kudo")

func writeKudoError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNotAMember):
		http.Error(w, `{"error":"only members of this space can give kudos"}`, http.StatusForbidden)
	case errors.Is(err, store.ErrSelfKudo):
		http.Error(w, `{"error":"a kudo cannot be sent to yourself"}`, http.StatusBadRequest)
	case errors.Is(err, store.ErrNotAMember):
		http.Error(w, `{"error":"a kudo can only be sent to a member of this space"}`, http.StatusBadRequest)
	case errors.Is(err, store.ErrQuotaExceeded):
		http.Error(w, `{"error":"kudo limit reached for this space"}`, http.StatusConflict)
	default:
		writeMutationError(w, err, "could not save your kudo")
	}
}
