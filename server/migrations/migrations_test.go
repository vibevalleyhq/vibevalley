package migrations

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// A farm from before Session keeps its rows: a worker participant speaks as an agent, its issues, runs and memories hold
// the same ids under session, and the JSON in the ledger names the session.
func TestSessionMigrationKeepsTheRows(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	first, _ := FS.ReadFile("0001_schema.sql")
	for _, q := range []string{string(first), "pragma user_version = 1",
		`insert into participant (id, kind, name, agent_id, joined_at) values ('w3', 'worker', '帮工', 'lab', 1), ('user', 'user', '主人', null, 1)`,
		`insert into conversation (id, kind, name, created_at) values (1, 'general', '田头', 1)`,
		`insert into message (seq, conversation_id, sender_id, kind, body, meta, created_at) values (1, 1, 'w3', 'chat', 'hi', '{"worker":"w3"}', 1)`,
		`insert into delivery (recipient_id, message_seq, reason, wakes, state, session, created_at) values ('user', 1, 'general', 0, 'handed', 'w3#1', 1)`,
		`insert into issue (id, description, created_at) values ('t1', '', 1)`,
		`insert into issue_worker (worker, issue, started_at) values ('w3', 't1', 1)`,
		`insert into run (worker, issue, triggered_by, started_at) values ('w3', 't1', 'issue', 1)`,
		`insert into memory (agent, kind, body, worker, created_at) values ('lab', 'issue', 'x', 'w3', 1)`,
		`insert into ledger (kind, at, payload) values ('reviewed', 1, '{"worker":"w3"}')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%.60s: %v", q, err)
		}
	}
	if ran, err := Up(db, ":memory:"); err != nil || len(ran) != len(Names())-1 {
		t.Fatalf("ran %v: %v", ran, err)
	}
	var kind, session, run, memory, launch, ledger, meta string
	for q, dst := range map[string]*string{
		"select kind from channel_participant where id = 'w3'": &kind,
		"select session from issue_session where issue = 't1'": &session,
		"select session from session_run":                      &run,
		"select session from memory":                           &memory,
		"select launch from channel_delivery":                  &launch,
		"select payload from game_ledger":                      &ledger,
		"select meta from channel_message":                     &meta,
	} {
		if err := db.QueryRow(q).Scan(dst); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	got := []string{kind, session, run, memory, launch, ledger, meta}
	want := []string{"agent", "w3", "w3", "w3", "w3#1", `{"session":"w3"}`, `{"session":"w3"}`}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
	var on int
	if db.QueryRow("pragma foreign_keys").Scan(&on); on != 1 {
		t.Fatal("foreign keys are off after migrating")
	}
	if _, err := db.Exec(`insert into channel_participant (id, kind, name, joined_at) values ('w4', 'worker', 'x', 1)`); err == nil {
		t.Fatal("a worker participant is still allowed")
	}
}
