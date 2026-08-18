package poker

import (
	"fmt"

	"github.com/lets-parley/parley/internal/session"
)

func init() {
	session.RegisterCSV("poker", exportCSV)
}

func exportCSV(env session.Envelope) ([][]string, error) {
	st, ok := env.State.(State)
	if !ok {
		return nil, fmt.Errorf("unexpected state type for poker export")
	}
	names := map[string]string{}
	for _, p := range env.Participants {
		names[p.UserID] = p.Name
	}
	rows := [][]string{{"ticket", "story", "status", "estimate", "votes", "detail"}}
	for _, s := range st.Stories {
		detail := ""
		// Vote values exist in the wire state only for the revealed current
		// story; everything else exports without them by construction.
		for _, v := range s.Votes {
			if detail != "" {
				detail += "; "
			}
			detail += names[v.UserID] + ": " + v.Value
		}
		estimate := ""
		if s.Estimate != nil {
			estimate = *s.Estimate
		}
		rows = append(rows, []string{
			session.SanitizeCell(s.Ref),
			session.SanitizeCell(s.Title),
			s.Status,
			session.SanitizeCell(estimate),
			fmt.Sprint(len(s.VotedUserIDs)),
			session.SanitizeCell(detail),
		})
	}
	return rows, nil
}
