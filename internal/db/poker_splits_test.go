package db

import (
	"context"
	"io"
	"io/fs"
	"log/slog"
	"testing"
	"testing/fstest"
)

func TestPokerSplitMigrationPreservesFlatHistory(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := pool.Exec(ctx, "drop schema public cascade; create schema public"); err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	entries, err := fs.ReadDir(MigrationsFS, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() >= "0052_" {
			continue
		}
		path := "migrations/" + e.Name()
		raw, err := fs.ReadFile(MigrationsFS, path)
		if err != nil {
			t.Fatal(err)
		}
		before[path] = &fstest.MapFile{Data: raw}
	}
	if err := Migrate(ctx, pool, log, before); err != nil {
		t.Fatal(err)
	}
	var user, space, sessionID, story string
	if err := pool.QueryRow(ctx, "insert into users(name) values('Historical') returning id::text").Scan(&user); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into spaces(slug,name) values('historical','Historical') returning id::text").Scan(&space); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into sessions(space_id,kind,title,facilitator_id,ended_at) values($1,'poker','Historical',$2,now()) returning id::text", space, user).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "insert into stories(session_id,title,notes,ref,position,estimate,status) values($1,'Original','Retained notes','PAR-1',4,'13','estimated') returning id::text", sessionID).Scan(&story); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "insert into votes(story_id,user_id,value) values($1,$2,'13')", story, user); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, log, MigrationsFS); err != nil {
		t.Fatal(err)
	}
	var role, title, notes, ref, estimate, vote string
	var parent *string
	var rev, split int64
	var position float64
	if err := pool.QueryRow(ctx, `select planning_role,parent_id::text,content_revision,split_revision,title,notes,ref,position,estimate from stories where id=$1`, story).Scan(&role, &parent, &rev, &split, &title, &notes, &ref, &position, &estimate); err != nil {
		t.Fatal(err)
	}
	if role != "planning" || parent != nil || rev != 0 || split != 0 || title != "Original" || notes != "Retained notes" || ref != "PAR-1" || position != 4 || estimate != "13" {
		t.Fatal("migration changed flat history")
	}
	if err := pool.QueryRow(ctx, "select value from votes where story_id=$1 and user_id=$2", story, user).Scan(&vote); err != nil || vote != "13" {
		t.Fatalf("historical vote: %q %v", vote, err)
	}
}
