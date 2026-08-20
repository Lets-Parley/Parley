package standup

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lets-parley/parley/internal/session"
	"github.com/lets-parley/parley/internal/store"
)

type Config struct {
	SecondsPerPerson int `json:"secondsPerPerson"`
}

func (c Config) secondsOrDefault() int {
	if c.SecondsPerPerson <= 0 {
		return 90
	}
	return c.SecondsPerPerson
}

type WireEntry struct {
	UserID    string  `json:"userId"`
	Yesterday string  `json:"yesterday"`
	Today     string  `json:"today"`
	Blockers  string  `json:"blockers"`
	Position  float64 `json:"position"`
	Skipped   bool    `json:"skipped"`
	Ready     bool    `json:"ready"`
}

type State struct {
	Entries          []WireEntry `json:"entries"`
	CurrentSpeakerID *string     `json:"currentSpeakerId"`
	SpeakerStartedAt *time.Time  `json:"speakerStartedAt"`
	SecondsPerPerson int         `json:"secondsPerPerson"`
}

// Kind describes the standup session kind for the core registry.
func Kind() session.Kind {
	return session.Kind{
		Name:      "standup",
		State:     buildState,
		NewConfig: func() any { return &Config{} },
		CSV:       exportCSV,
		Actions:   actions(),
	}
}

func buildState(ctx context.Context, pool *pgxpool.Pool, sess store.Session) (any, error) {
	var cfg Config
	json.Unmarshal(sess.Config, &cfg)

	st := State{Entries: []WireEntry{}, SecondsPerPerson: cfg.secondsOrDefault()}

	var speaker *string
	var started *time.Time
	if err := pool.QueryRow(ctx,
		"select current_speaker_id::text, speaker_started_at from sessions where id = $1", sess.ID,
	).Scan(&speaker, &started); err != nil {
		return nil, err
	}
	st.CurrentSpeakerID = speaker
	st.SpeakerStartedAt = started

	rows, err := pool.Query(ctx, `
		select user_id::text, yesterday, today, blockers, position, skipped, ready
		from standup_entries where session_id = $1 order by position`, sess.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e WireEntry
		if err := rows.Scan(&e.UserID, &e.Yesterday, &e.Today, &e.Blockers, &e.Position, &e.Skipped, &e.Ready); err != nil {
			return nil, err
		}
		st.Entries = append(st.Entries, e)
	}
	return st, rows.Err()
}
