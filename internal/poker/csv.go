package poker

import (
	"fmt"

	"github.com/lets-parley/parley/internal/session"
)

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
	split := false
	for _, s := range st.Stories {
		if s.ParentID != nil {
			split = true
			break
		}
	}
	if split {
		rows[0] = append(rows[0], "story_id", "parent_id", "planning_role", "content_revision", "split_revision", "removed", "is_remainder")
	}
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
		row := []string{
			session.SanitizeCell(s.Ref),
			session.SanitizeCell(s.Title),
			s.Status,
			session.SanitizeCell(estimate),
			fmt.Sprint(len(s.VotedUserIDs)),
			session.SanitizeCell(detail),
		}
		if split {
			parent := ""
			if s.ParentID != nil {
				parent = *s.ParentID
			}
			row = append(row, s.ID, parent, s.PlanningRole, fmt.Sprint(s.ContentRevision), fmt.Sprint(s.SplitRevision), fmt.Sprint(s.RemovedAt != nil), fmt.Sprint(s.IsRemainder))
		}
		rows = append(rows, row)
	}
	return rows, nil
}
