package poker

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jacorbello/parley/internal/session"
	"github.com/jacorbello/parley/internal/store"
)

type WireVote struct {
	UserID string `json:"userId"`
	Value  string `json:"value"`
}

type WireStory struct {
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	Notes        string     `json:"notes"`
	Position     float64    `json:"position"`
	Estimate     *string    `json:"estimate"`
	Status       string     `json:"status"`
	VotedUserIDs []string   `json:"votedUserIds"`
	Votes        []WireVote `json:"votes,omitempty"`
	Results      *Results   `json:"results,omitempty"`
}

type State struct {
	Deck           Deck        `json:"deck"`
	CurrentStoryID *string     `json:"currentStoryId"`
	Stories        []WireStory `json:"stories"`
}

func init() {
	session.Register("poker", buildState, func() any { return &Config{} })
}

// buildState produces client-safe state only: before reveal, vote VALUES never
// leave the database — not even the caller's own — so no serializer downstream
// of this function can leak them.
func buildState(ctx context.Context, pool *pgxpool.Pool, sess store.Session) (any, error) {
	var cfg Config
	if err := json.Unmarshal(sess.Config, &cfg); err != nil {
		return nil, err
	}
	deck, ok := DeckByName(cfg.Deck)
	if !ok {
		deck, _ = DeckByName("fibonacci")
	}

	st := State{Deck: deck, Stories: []WireStory{}}

	var currentID string
	if err := pool.QueryRow(ctx,
		"select coalesce(current_story_id::text, '') from sessions where id = $1", sess.ID,
	).Scan(&currentID); err != nil {
		return nil, err
	}
	if currentID != "" {
		st.CurrentStoryID = &currentID
	}

	rows, err := pool.Query(ctx, `
		select s.id, s.title, s.notes, s.position, s.estimate, s.status,
		       coalesce(array_agg(v.user_id::text) filter (where v.user_id is not null), '{}')
		from stories s
		left join votes v on v.story_id = s.id
		where s.session_id = $1
		group by s.id
		order by s.position`, sess.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ws WireStory
		if err := rows.Scan(&ws.ID, &ws.Title, &ws.Notes, &ws.Position, &ws.Estimate, &ws.Status, &ws.VotedUserIDs); err != nil {
			return nil, err
		}
		st.Stories = append(st.Stories, ws)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if sess.Revealed && currentID != "" {
		votes, values, err := currentVotes(ctx, pool, currentID)
		if err != nil {
			return nil, err
		}
		results := Summarize(deck, values)
		for i := range st.Stories {
			if st.Stories[i].ID == currentID {
				st.Stories[i].Votes = votes
				st.Stories[i].Results = &results
			}
		}
	}
	return st, nil
}

func currentVotes(ctx context.Context, pool *pgxpool.Pool, storyID string) ([]WireVote, []string, error) {
	rows, err := pool.Query(ctx,
		"select user_id::text, value from votes where story_id = $1 order by user_id", storyID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	votes := []WireVote{}
	values := []string{}
	for rows.Next() {
		var v WireVote
		if err := rows.Scan(&v.UserID, &v.Value); err != nil {
			return nil, nil, err
		}
		votes = append(votes, v)
		values = append(values, v.Value)
	}
	return votes, values, rows.Err()
}
