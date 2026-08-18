package standup

import (
	"fmt"

	"github.com/lets-parley/parley/internal/session"
)

func init() {
	session.RegisterCSV("standup", exportCSV)
}

func exportCSV(env session.Envelope) ([][]string, error) {
	st, ok := env.State.(State)
	if !ok {
		return nil, fmt.Errorf("unexpected state type for standup export")
	}
	names := map[string]string{}
	for _, p := range env.Participants {
		names[p.UserID] = p.Name
	}
	rows := [][]string{{"name", "yesterday", "today", "blockers", "skipped"}}
	for _, e := range st.Entries {
		rows = append(rows, []string{
			session.SanitizeCell(names[e.UserID]),
			session.SanitizeCell(e.Yesterday),
			session.SanitizeCell(e.Today),
			session.SanitizeCell(e.Blockers),
			fmt.Sprint(e.Skipped),
		})
	}
	return rows, nil
}
