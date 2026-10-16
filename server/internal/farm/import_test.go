package farm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

const importTestDump = `{
  "format": "heybro-pglite-dump", "version": 1, "source": "/old/home", "dumpedAt": 1791000000000,
  "sequences": {"conversations.id": 7, "messages.seq": 10, "ledger.seq": 2, "memories.id": 1, "schedules.id": 3, "connector_outbox.id": 0, "playbook_events.seq": 0},
  "tables": {
    "effect_sql_migrations": {"columns": [{"name": "migration_id", "type": "integer"}, {"name": "created_at", "type": "timestamp with time zone"}, {"name": "name", "type": "text"}],
      "rows": [{"migration_id": 1, "created_at": 1791000000000, "name": "chat"}]},
    "participants": {"columns": [{"name": "id", "type": "text"}, {"name": "kind", "type": "text"}, {"name": "name", "type": "text"}, {"name": "agent_id", "type": "text"}, {"name": "runtime", "type": "text"}, {"name": "joined_at", "type": "timestamp with time zone"}, {"name": "left_at", "type": "timestamp with time zone"}],
      "rows": [
        {"id": "user", "kind": "user", "name": "主人", "agent_id": null, "runtime": null, "joined_at": 1791000000000, "left_at": null},
        {"id": "foreman", "kind": "foreman", "name": "管家", "agent_id": null, "runtime": null, "joined_at": 1791000000000, "left_at": null},
        {"id": "system", "kind": "system", "name": "农场", "agent_id": null, "runtime": null, "joined_at": 1791000000000, "left_at": null},
        {"id": "w1", "kind": "helper", "name": "后端老周", "agent_id": "backend", "runtime": "claude", "joined_at": 1791000001000, "left_at": 1791000009000}]},
    "conversations": {"columns": [{"name": "id", "type": "integer"}, {"name": "kind", "type": "text"}, {"name": "parent_seq", "type": "integer"}, {"name": "subject_kind", "type": "text"}, {"name": "subject_id", "type": "text"}, {"name": "last_seq", "type": "integer"}, {"name": "reply_count", "type": "integer"}, {"name": "created_at", "type": "timestamp with time zone"}, {"name": "name", "type": "text"}, {"name": "description", "type": "text"}, {"name": "project", "type": "text"}, {"name": "channel_id", "type": "integer"}],
      "rows": [
        {"id": 1, "kind": "square", "parent_seq": null, "subject_kind": null, "subject_id": null, "last_seq": 3, "reply_count": 0, "created_at": 1791000000000, "name": "田头", "description": null, "project": null, "channel_id": null},
        {"id": 7, "kind": "thread", "parent_seq": 3, "subject_kind": "job", "subject_id": "w1", "last_seq": 5, "reply_count": 1, "created_at": 1791000002000, "name": null, "description": null, "project": null, "channel_id": 1}]},
    "messages": {"columns": [{"name": "seq", "type": "integer"}, {"name": "conversation_id", "type": "integer"}, {"name": "sender_id", "type": "text"}, {"name": "kind", "type": "text"}, {"name": "body", "type": "text"}, {"name": "final", "type": "boolean"}, {"name": "meta", "type": "jsonb"}, {"name": "send_key", "type": "text"}, {"name": "created_at", "type": "timestamp with time zone"}, {"name": "updated_at", "type": "timestamp with time zone"}],
      "rows": [
        {"seq": 3, "conversation_id": 1, "sender_id": "foreman", "kind": "dispatch", "body": "派 @w1 去 clock-in", "final": true, "meta": {"helper": "w1", "mentions": ["w1"]}, "send_key": null, "created_at": 1791000002000, "updated_at": null},
        {"seq": 5, "conversation_id": 7, "sender_id": "w1", "kind": "report", "body": "做完了", "final": false, "meta": {"outcome": "completed", "spent": {"tokens": 12}}, "send_key": "k1", "created_at": 1791000003000, "updated_at": 1791000003500}]},
    "mentions": {"columns": [{"name": "message_seq", "type": "integer"}, {"name": "target_id", "type": "text"}, {"name": "resolved", "type": "text"}],
      "rows": [{"message_seq": 3, "target_id": "w1", "resolved": "delivered"}]},
    "follows": {"columns": [{"name": "conversation_id", "type": "integer"}, {"name": "participant_id", "type": "text"}, {"name": "reason", "type": "text"}, {"name": "from_seq", "type": "integer"}, {"name": "unfollowed_at", "type": "timestamp with time zone"}],
      "rows": [{"conversation_id": 7, "participant_id": "w1", "reason": "owner", "from_seq": 3, "unfollowed_at": null}]},
    "read_cursors": {"columns": [{"name": "participant_id", "type": "text"}, {"name": "conversation_id", "type": "integer"}, {"name": "read_seq", "type": "integer"}, {"name": "updated_at", "type": "timestamp with time zone"}],
      "rows": [{"participant_id": "user", "conversation_id": 1, "read_seq": 3, "updated_at": 1791000004000}]},
    "seen_marks": {"columns": [{"name": "participant_id", "type": "text"}, {"name": "message_seq", "type": "integer"}], "rows": []},
    "deliveries": {"columns": [{"name": "recipient_id", "type": "text"}, {"name": "message_seq", "type": "integer"}, {"name": "reason", "type": "text"}, {"name": "wakes", "type": "boolean"}, {"name": "held_by", "type": "text"}, {"name": "state", "type": "text"}, {"name": "session", "type": "text"}, {"name": "announced_at", "type": "timestamp with time zone"}, {"name": "handed_at", "type": "timestamp with time zone"}, {"name": "seen_at", "type": "timestamp with time zone"}, {"name": "dropped_why", "type": "text"}, {"name": "created_at", "type": "timestamp with time zone"}],
      "rows": [{"recipient_id": "foreman", "message_seq": 5, "reason": "own_thread", "wakes": false, "held_by": null, "state": "seen", "session": "s1", "announced_at": null, "handed_at": 1791000003100, "seen_at": 1791000003200, "dropped_why": null, "created_at": 1791000003000}]},
    "playbook_events": {"columns": [{"name": "seq", "type": "integer"}, {"name": "playbook_id", "type": "text"}, {"name": "node_id", "type": "text"}, {"name": "kind", "type": "text"}, {"name": "actor", "type": "text"}, {"name": "payload", "type": "jsonb"}, {"name": "created_at", "type": "timestamp with time zone"}], "rows": []},
    "ledger": {"columns": [{"name": "seq", "type": "integer"}, {"name": "kind", "type": "text"}, {"name": "at", "type": "timestamp with time zone"}, {"name": "payload", "type": "jsonb"}],
      "rows": [{"seq": 1, "kind": "voice", "at": 1791000001000, "payload": {}}, {"seq": 2, "kind": "reviewed", "at": 1791000005000, "payload": {"helper": "w1"}}]},
    "memories": {"columns": [{"name": "id", "type": "integer"}, {"name": "agent", "type": "text"}, {"name": "kind", "type": "text"}, {"name": "body", "type": "text"}, {"name": "project", "type": "text"}, {"name": "helper", "type": "text"}, {"name": "created_at", "type": "timestamp with time zone"}, {"name": "recalled", "type": "integer"}, {"name": "recalled_at", "type": "timestamp with time zone"}],
      "rows": [{"id": 1, "agent": "backend", "kind": "note", "body": "测试用 pnpm test", "project": "clock-in", "helper": null, "created_at": 1791000006000, "recalled": 2, "recalled_at": 1791000007000}]},
    "connector_accounts": {"columns": [{"name": "connector", "type": "text"}, {"name": "secrets", "type": "jsonb"}, {"name": "owner_id", "type": "text"}, {"name": "pair_code", "type": "text"}, {"name": "cursor", "type": "text"}, {"name": "reply_context", "type": "text"}, {"name": "reply_at", "type": "timestamp with time zone"}, {"name": "last_inbound", "type": "timestamp with time zone"}, {"name": "paused_until", "type": "timestamp with time zone"}, {"name": "connected_at", "type": "timestamp with time zone"}, {"name": "channel_id", "type": "integer"}],
      "rows": [{"connector": "qq", "secrets": {"appId": "1", "secret": "s3cret"}, "owner_id": null, "pair_code": "123456", "cursor": "", "reply_context": null, "reply_at": null, "last_inbound": null, "paused_until": null, "connected_at": 1791000000000, "channel_id": null}]},
    "connector_inbound": {"columns": [{"name": "connector", "type": "text"}, {"name": "ext_id", "type": "text"}, {"name": "message_seq", "type": "integer"}, {"name": "created_at", "type": "timestamp with time zone"}], "rows": []},
    "connector_outbox": {"columns": [{"name": "id", "type": "integer"}, {"name": "connector", "type": "text"}, {"name": "message_seq", "type": "integer"}, {"name": "body", "type": "text"}, {"name": "state", "type": "text"}, {"name": "ext_id", "type": "text"}, {"name": "tries", "type": "integer"}, {"name": "error", "type": "text"}, {"name": "created_at", "type": "timestamp with time zone"}, {"name": "sent_at", "type": "timestamp with time zone"}], "rows": []},
    "schedules": {"columns": [{"name": "id", "type": "integer"}, {"name": "name", "type": "text"}, {"name": "body", "type": "text"}, {"name": "channel_id", "type": "integer"}, {"name": "agent", "type": "text"}, {"name": "project", "type": "text"}, {"name": "spec", "type": "jsonb"}, {"name": "tz", "type": "text"}, {"name": "enabled", "type": "boolean"}, {"name": "created_at", "type": "timestamp with time zone"}, {"name": "last_run", "type": "timestamp with time zone"}],
      "rows": [{"id": 3, "name": "早报", "body": "说说昨天的进展", "channel_id": 1, "agent": null, "project": null, "spec": {"kind": "daily", "time": "09:00"}, "tz": "Asia/Shanghai", "enabled": false, "created_at": 1791000000000, "last_run": null}]}
  }
}`

func importTestHome(t *testing.T) (home, dump string) {
	t.Helper()
	home = t.TempDir()
	write := func(name, body string, mode os.FileMode) {
		path := filepath.Join(home, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}
	write("farm.json", `{"call":"idle","foreman":"listening","helpers":[],"reports":[{"workerId":"w1","workerName":"后端老周","agent":"backend","runtime":"claude","task":"打卡","outcome":"completed","summary":"好了","at":1791000003000}],"commits":{"total":0,"repos":[]},"playbooks":[]}`, 0o644)
	write("config.json", `{"agents":[{"id":"backend","name":"后端老周","runtime":"claude","look":{"face":"0","hair":"0","outfit":"0"},"skills":[],"bestFor":"后端","worktree":true},{"id":"lab","name":"实验员","runtime":"heybro","look":{"face":"0","hair":"0","outfit":"0"},"skills":[],"bestFor":"试","worktree":true}],"skills":[],"settings":{"claude":{"enabled":true,"binPath":"","defaultModel":"opus","defaultEffort":"","env":{}}}}`, 0o644)
	write("crew.json", `{"hired":1,"hands":[]}`, 0o644)
	write("settings.json", `{"deepseekApiKey":"sk-not-printed"}`, 0o600)
	write(".env", "DEEPSEEK_API_KEY=sk-not-printed\n", 0o600)
	write("foreman/MEMORY.md", "- 2026-10-01 主人交代：先跑测试\n", 0o644)
	write("foreman/manager.jsonl", `{"role":"user","content":"你好","timestamp":1791000000000}`+"\n", 0o644)
	write("steps/w1.head.json", `{"id":"w1","name":"后端老周","startedAt":1791000001000}`, 0o644)
	write("steps/w1.json", `[]`, 0o644)
	write("db/PG_VERSION", "17\n", 0o600)
	dump = filepath.Join(t.TempDir(), "dump.json")
	if err := os.WriteFile(dump, []byte(importTestDump), 0o600); err != nil {
		t.Fatal(err)
	}
	return home, dump
}

func TestImportAFarmFromTheTypeScriptServer(t *testing.T) {
	from, dump := importTestHome(t)
	into := filepath.Join(t.TempDir(), "go-home")

	if _, err := Import(ImportOptions{From: from, Into: into}); err == nil || !strings.Contains(err.Error(), "dump-pglite.ts") {
		t.Fatalf("no dump: %v", err)
	}
	report, err := Import(ImportOptions{From: from, Into: into, Dump: dump})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(report.Skipped, ",") != "effect_sql_migrations" {
		t.Fatalf("skipped %v", report.Skipped)
	}
	if config, _ := os.ReadFile(filepath.Join(into, "config.json")); !strings.Contains(string(config), `"runtime":"vibevalley"`) || strings.Contains(string(config), `"heybro"`) {
		t.Fatalf("config.json: %s", config)
	}
	for _, table := range report.Tables {
		if table.Dumped != table.Stored {
			t.Fatalf("%s: %d dumped, %d stored", table.Name, table.Dumped, table.Stored)
		}
	}
	if _, err := os.Stat(filepath.Join(into, "db")); err == nil {
		t.Fatal("the PGlite folder was copied")
	}
	if info, err := os.Stat(filepath.Join(into, "settings.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("settings.json: %v %v", info, err)
	}

	raw, err := base.OpenDB(filepath.Join(into, "farm.db"))
	if err != nil {
		t.Fatal(err)
	}
	var final int
	raw.QueryRow("select final from messages where seq = 5").Scan(&final)
	raw.Close()
	if final != 0 {
		t.Fatalf("final %d", final)
	}

	f, err := New(base.Config{Home: into, WorkRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	thread, err := f.Chat.History(7, nil, nil)
	if err != nil || len(thread) != 1 || thread[0].Seq != 5 || thread[0].Text != "做完了" || thread[0].Outcome == nil || *thread[0].Outcome != protocol.OutcomeCompleted {
		t.Fatalf("thread: %+v %v", thread, err)
	}
	square, err := f.Chat.History(1, nil, nil)
	if err != nil || len(square) != 1 || square[0].Seq != 3 || square[0].Kind != protocol.MessageKindDispatch {
		t.Fatalf("square: %+v %v", square, err)
	}
	var wakes int
	var readSeq int64
	f.DB.QueryRow("select wakes from deliveries where message_seq = 5").Scan(&wakes)
	f.DB.QueryRow("select read_seq from read_cursors where participant_id = 'user' and conversation_id = 1").Scan(&readSeq)
	if wakes != 0 || readSeq != 3 {
		t.Fatalf("wakes %d, read %d", wakes, readSeq)
	}
	var secrets string
	f.DB.QueryRow("select secrets from connector_accounts where connector = 'qq'").Scan(&secrets)
	if secrets != `{"appId":"1","secret":"s3cret"}` {
		t.Fatalf("secrets kept as %q", secrets)
	}
	var entries int
	if err := f.DB.QueryRow("select count(*) from ledger").Scan(&entries); err != nil || entries != 2 {
		t.Fatalf("ledger: %d %v", entries, err)
	}
	if m := f.Memories.List("backend"); len(m) != 1 || m[0].Text != "测试用 pnpm test" {
		t.Fatalf("memories: %+v", m)
	}
	if s := f.Schedules.List(); len(s) != 1 || s[0].Name != "早报" || s[0].Enabled {
		t.Fatalf("schedules: %+v", s)
	}
	if a := f.Store.Agents(); len(a) != 2 || a[0].ID != "backend" || a[1].Runtime != "vibevalley" {
		t.Fatalf("agents: %+v", a)
	}
	if s := f.Store.Settings("claude"); s.DefaultModel != "opus" {
		t.Fatalf("runtime settings: %+v", s)
	}

	var seq int64
	err = f.DB.QueryRow(`insert into messages (conversation_id, sender_id, kind, body, final, meta, created_at) values (1, 'user', 'chat', '接着说', 1, null, ?) returning seq`, base.NowMs()).Scan(&seq)
	if err != nil || seq != 11 {
		t.Fatalf("next seq %d: %v", seq, err)
	}
	var id int64
	if err := f.DB.QueryRow("insert into memories (agent, kind, body, created_at) values ('backend', 'note', 'x', 0) returning id").Scan(&id); err != nil || id != 2 {
		t.Fatalf("next memory id %d: %v", id, err)
	}
	f.Close()

	if _, err := Import(ImportOptions{From: from, Into: into, Dump: dump}); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("over a farm: %v", err)
	}
	if _, err := Import(ImportOptions{From: from, Into: into, Dump: dump, Force: true}); err != nil {
		t.Fatal(err)
	}
	f2, err := New(base.Config{Home: into, WorkRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer f2.Close()
	if square, _ := f2.Chat.History(1, nil, nil); len(square) != 1 {
		t.Fatalf("after --force the square has %d messages", len(square))
	}
}

func TestImportRefusesWhatIsNotADump(t *testing.T) {
	from, _ := importTestHome(t)
	bad := filepath.Join(t.TempDir(), "bad.json")
	os.WriteFile(bad, []byte(`{"format":"something-else","version":1}`), 0o600)
	if _, err := Import(ImportOptions{From: from, Into: t.TempDir(), Dump: bad}); err == nil {
		t.Fatal("imported a file that is not a dump")
	}
	var dump map[string]any
	json.Unmarshal([]byte(importTestDump), &dump)
	dump["tables"].(map[string]any)["mystery"] = map[string]any{"columns": []any{}, "rows": []any{}}
	body, _ := json.Marshal(dump)
	unknown := filepath.Join(t.TempDir(), "unknown.json")
	os.WriteFile(unknown, body, 0o600)
	if _, err := Import(ImportOptions{From: from, Into: t.TempDir(), Dump: unknown}); err == nil || !strings.Contains(err.Error(), "mystery") {
		t.Fatalf("a table it does not know: %v", err)
	}
	if _, err := Import(ImportOptions{From: from, Into: from}); err == nil {
		t.Fatal("imported a home into itself")
	}
}
