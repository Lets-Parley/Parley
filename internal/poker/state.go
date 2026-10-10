package poker

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

type WireVote struct {
	UserID string `json:"userId"`
	Value  string `json:"value"`
}

type WireStory struct {
	ParentID           *string    `json:"parentId"`
	PlanningRole       string     `json:"planningRole"`
	ContentRevision    int64      `json:"contentRevision"`
	DependencyRevision int64      `json:"dependencyRevision"`
	SplitRevision      int64      `json:"splitRevision"`
	CreationOperation  *string    `json:"creationOperation"`
	RemovedAt          *time.Time `json:"removedAt"`
	IsRemainder        bool       `json:"isRemainder"`
	Coverage           *string    `json:"coverage"`
	ID                 string     `json:"id"`
	Ref                string     `json:"ref"`
	Title              string     `json:"title"`
	Notes              string     `json:"notes"`
	Position           float64    `json:"position"`
	Estimate           *string    `json:"estimate"`
	Status             string     `json:"status"`
	VotedUserIDs       []string   `json:"votedUserIds"`
	Votes              []WireVote `json:"votes,omitempty"`
	Results            *Results   `json:"results,omitempty"`
}

type State struct {
	Dependencies     []WireDependency `json:"dependencies"`
	DependencyNotice string           `json:"dependencyNotice"`
	Deck             wireDeck         `json:"deck"`
	AutoReveal       bool             `json:"autoReveal"`
	OpenVoting       bool             `json:"openVoting"`
	RoundVersion     int64            `json:"roundVersion"`
	CurrentStoryID   *string          `json:"currentStoryId"`
	Stories          []WireStory      `json:"stories"`
}

// Kind describes the poker session kind for the core registry.
func Kind() session.Kind {
	return session.Kind{
		Name:      "poker",
		State:     buildState,
		NewConfig: func() any { return &Config{} },
		CSV:       exportCSV,
		Actions:   actions(),
		// A round waits for the people who can still vote, so the moment
		// somebody sits out it may already be complete.
		RosterChanged: rosterChanged,
	}
}

// buildState produces client-safe state only: before reveal, vote VALUES never
// leave the database — not even the caller's own — so no serializer downstream
// of this function can leak them.
func buildState(ctx context.Context, pool *pgxpool.Pool, sess store.Session) (any, error) {
	var cfg Config
	if err := json.Unmarshal(sess.Config, &cfg); err != nil {
		return nil, err
	}
	deck := cfg.ResolveDeck()

	st := State{Deck: wireDeck(deck), AutoReveal: cfg.AutoReveal, OpenVoting: cfg.OpenVoting, Stories: []WireStory{}, Dependencies: []WireDependency{}, DependencyNotice: "Planning dependency · Completion not checked"}

	var currentID string
	if err := pool.QueryRow(ctx,
		"select coalesce(current_story_id::text, ''), poker_round_version from sessions where id = $1", sess.ID,
	).Scan(&currentID, &st.RoundVersion); err != nil {
		return nil, err
	}
	if currentID != "" {
		st.CurrentStoryID = &currentID
	}

	rows, err := pool.Query(ctx, `
		select s.id, s.ref, s.title, s.notes, s.position, s.estimate, s.status,
		       s.parent_id::text,s.planning_role,s.content_revision,s.split_revision,s.dependency_revision,s.creation_operation,s.removed_at,s.is_remainder,s.coverage,
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
		if err := rows.Scan(&ws.ID, &ws.Ref, &ws.Title, &ws.Notes, &ws.Position, &ws.Estimate, &ws.Status,
			&ws.ParentID, &ws.PlanningRole, &ws.ContentRevision, &ws.SplitRevision, &ws.DependencyRevision, &ws.CreationOperation, &ws.RemovedAt, &ws.IsRemainder, &ws.Coverage, &ws.VotedUserIDs); err != nil {
			return nil, err
		}
		st.Stories = append(st.Stories, ws)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	dependencyRows, err := pool.Query(ctx, `select d.id::text,d.parent_id::text,d.blocker_id::text,d.dependent_id::text,
 case when d.retired_at is not null then 'retired' when a.removed_at is not null then 'blocker-removed-review' when b.removed_at is not null then 'dependent-removed-review' when d.review_needed then 'review-needed' else 'planning' end,d.retired_at
 from poker_dependencies d join stories a on a.id=d.blocker_id join stories b on b.id=d.dependent_id where d.session_id=$1 order by d.id`, sess.ID)
	if err != nil {
		return nil, err
	}
	for dependencyRows.Next() {
		var d WireDependency
		if err := dependencyRows.Scan(&d.ID, &d.ParentID, &d.BlockerID, &d.DependentID, &d.ReviewState, &d.RetiredAt); err != nil {
			dependencyRows.Close()
			return nil, err
		}
		st.Dependencies = append(st.Dependencies, d)
	}
	err = dependencyRows.Err()
	dependencyRows.Close()
	if err != nil {
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
