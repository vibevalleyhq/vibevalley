// Command import-ts reads a TypeScript-era farm (the SQLite file the old server left: backlog, issue, messages,
// ledger, memories and the steps/ logs) and writes it into a home in today's shape. It runs once: after the owner's
// farm is imported and checked, this command goes, like the old `vibevalley import` did.
//
//	go run ./tool/import-ts -db "$HOME/Library/Application Support/vibevalley/farm.db" -home "$HOME/Library/Application Support/vibevalley"
//
// The home must have an empty database (no issues); the files that are already today's (config.json, settings.json,
// spend.json) are left alone. The old files are not touched: the command only reads the database and the steps it is
// pointed at.
package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

func main() {
	dbPath := flag.String("db", "", "the TypeScript farm.db")
	home := flag.String("home", "", "the home to write today's farm into")
	steps := flag.String("steps", "", "the old steps directory (default: beside the db)")
	flag.Parse()
	if *dbPath == "" || *home == "" {
		fmt.Fprintln(os.Stderr, "usage: import-ts -db <farm.db> -home <home> [-steps <dir>]")
		os.Exit(2)
	}
	stepsDir := *steps
	if stepsDir == "" {
		stepsDir = filepath.Join(filepath.Dir(*dbPath), "steps")
	}
	if err := run(*dbPath, *home, stepsDir); err != nil {
		fmt.Fprintln(os.Stderr, "import-ts:", err)
		os.Exit(1)
	}
}

func run(dbPath, home, stepsDir string) error {
	if _, err := os.Stat(dbPath); err != nil {
		return fmt.Errorf("the old database: %w", err)
	}
	old, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return fmt.Errorf("open the old database: %w", err)
	}
	defer old.Close()
	if err := old.Ping(); err != nil {
		return fmt.Errorf("read the old database: %w", err)
	}

	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	db, err := base.OpenDB(filepath.Join(home, "vibevalley.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	var issues int
	if err := db.QueryRow("select count(*) from issue").Scan(&issues); err != nil {
		return err
	}
	if issues != 0 {
		return fmt.Errorf("%s already holds a farm; import only into an empty home", home)
	}

	// The old rows refer to each other both ways (a thread names the message it hangs under, the messages name their
	// conversation), so they cannot go in one order with foreign keys on; they are checked before this returns.
	if _, err := db.Exec("pragma foreign_keys = off"); err != nil {
		return err
	}
	defer db.Exec("pragma foreign_keys = on")

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := importRows(tx, old); err != nil {
		return err
	}
	if err := importSessions(tx, old, home, stepsDir); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	broken, err := db.Query("pragma foreign_key_check")
	if err != nil {
		return err
	}
	defer broken.Close()
	if broken.Next() {
		return fmt.Errorf("the imported rows point at things that are not there (foreign_key_check)")
	}
	return broken.Err()
}

// importRows copies the tables whose shapes did not change in meaning, and maps the names that did.
func importRows(tx *sql.Tx, old *sql.DB) error {
	if err := copyParticipants(tx, old); err != nil {
		return err
	}
	if err := copyConversations(tx, old); err != nil {
		return err
	}
	if err := copyMessages(tx, old); err != nil {
		return err
	}
	for _, copy := range []struct {
		query string
		args  func(*sql.Rows) ([]any, error)
		stmt  string
	}{
		{"select message_seq, target_id, resolved from mentions", mentionRow, "insert into channel_mention (message_seq, target_id, resolved) values (?, ?, ?)"},
		{"select conversation_id, participant_id, reason, from_seq, unfollowed_at from follows", followRow, "insert into channel_follow (conversation_id, participant_id, reason, from_seq, unfollowed_at) values (?, ?, ?, ?, ?)"},
		{"select participant_id, conversation_id, read_seq, updated_at from read_cursors", cursorRow, "insert into channel_read_cursor (participant_id, conversation_id, read_seq, updated_at) values (?, ?, ?, ?)"},
	} {
		if err := copyTable(tx, old, copy.query, copy.args, copy.stmt); err != nil {
			return err
		}
	}
	if err := copyIssues(tx, old); err != nil {
		return err
	}
	if err := copyMemories(tx, old); err != nil {
		return err
	}
	if err := copyLedger(tx, old); err != nil {
		return err
	}
	if err := copyGate(tx, old); err != nil {
		return err
	}
	if err := copySchedules(tx, old); err != nil {
		return err
	}
	if err := copyConnectors(tx, old); err != nil {
		return err
	}
	return nil
}

func rows(db *sql.DB, query string) (*sql.Rows, error) {
	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", query, err)
	}
	return rows, nil
}

func copyTable(tx *sql.Tx, old *sql.DB, query string, args func(*sql.Rows) ([]any, error), stmt string) error {
	rows, err := rows(old, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	insert, err := tx.Prepare(stmt)
	if err != nil {
		return err
	}
	defer insert.Close()
	for rows.Next() {
		vals, err := args(rows)
		if err != nil {
			return err
		}
		if _, err := insert.Exec(vals...); err != nil {
			return fmt.Errorf("%s: %w", stmt, err)
		}
	}
	return rows.Err()
}

func mentionRow(r *sql.Rows) ([]any, error) {
	var message, target, resolved string
	if err := r.Scan(&message, &target, &resolved); err != nil {
		return nil, err
	}
	return []any{message, participantID(target), resolved}, nil
}

func followRow(r *sql.Rows) ([]any, error) {
	var conversation, participant string
	var reason string
	var from int64
	var unfollowed sql.NullInt64
	if err := r.Scan(&conversation, &participant, &reason, &from, &unfollowed); err != nil {
		return nil, err
	}
	return []any{conversation, participantID(participant), reason, from, unfollowed}, nil
}

func cursorRow(r *sql.Rows) ([]any, error) {
	var participant, conversation string
	var read, updated int64
	if err := r.Scan(&participant, &conversation, &read, &updated); err != nil {
		return nil, err
	}
	return []any{participantID(participant), conversation, read, updated}, nil
}

// The old names for what the farm calls itself today: a manager, an agent, an issue.
func participantID(id string) string {
	if id == "foreman" {
		return "manager"
	}
	return id
}

func participantKind(kind string) string {
	switch kind {
	case "foreman":
		return "manager"
	case "helper":
		return "agent"
	}
	return kind
}

func copyParticipants(tx *sql.Tx, old *sql.DB) error {
	type participant struct {
		id, kind, name string
		agent          sql.NullString
		runtime        sql.NullString
		joined         int64
		left           sql.NullInt64
	}
	rows, err := rows(old, "select id, kind, name, agent_id, runtime, joined_at, left_at from participants")
	if err != nil {
		return err
	}
	defer rows.Close()
	var all []participant
	for rows.Next() {
		var p participant
		if err := rows.Scan(&p.id, &p.kind, &p.name, &p.agent, &p.runtime, &p.joined, &p.left); err != nil {
			return err
		}
		all = append(all, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, p := range all {
		if _, err := tx.Exec("insert into channel_participant (id, kind, name, agent_id, runtime, joined_at, left_at) values (?, ?, ?, ?, ?, ?, ?)",
			participantID(p.id), participantKind(p.kind), p.name, p.agent, p.runtime, p.joined, p.left); err != nil {
			return err
		}
	}
	return nil
}

func copyConversations(tx *sql.Tx, old *sql.DB) error {
	rows, err := rows(old, "select id, kind, parent_seq, subject_kind, subject_id, last_seq, reply_count, created_at, name, description, project, channel_id from conversations")
	if err != nil {
		return err
	}
	defer rows.Close()
	type conversation struct {
		id, replyCount, created int64
		kind                    string
		subjectKind             sql.NullString
		subjectID, name, desc   sql.NullString
		project                 sql.NullString
		parent, last, channel   sql.NullInt64
	}
	var all []conversation
	for rows.Next() {
		var c conversation
		if err := rows.Scan(&c.id, &c.kind, &c.parent, &c.subjectKind, &c.subjectID, &c.last, &c.replyCount, &c.created,
			&c.name, &c.desc, &c.project, &c.channel); err != nil {
			return err
		}
		if c.kind == "square" {
			c.kind = "general"
		}
		if c.subjectKind.String == "job" {
			c.subjectKind.String = "issue"
		}
		all = append(all, c)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, c := range all {
		if _, err := tx.Exec("insert into channel_conversation (id, kind, parent_seq, subject_kind, subject_id, last_seq, reply_count, created_at, name, description, project, channel_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			c.id, c.kind, c.parent, c.subjectKind, c.subjectID, c.last, c.replyCount, c.created, c.name, c.desc, c.project, c.channel); err != nil {
			return err
		}
	}
	return nil
}

func copyMessages(tx *sql.Tx, old *sql.DB) error {
	rows, err := rows(old, "select seq, conversation_id, sender_id, kind, body, final, meta, send_key, created_at, updated_at from messages")
	if err != nil {
		return err
	}
	defer rows.Close()
	type message struct {
		seq, conversation, created int64
		sender, kind, body         string
		final                      int64
		meta, sendKey              sql.NullString
		updated                    sql.NullInt64
	}
	var all []message
	for rows.Next() {
		var m message
		if err := rows.Scan(&m.seq, &m.conversation, &m.sender, &m.kind, &m.body, &m.final, &m.meta, &m.sendKey, &m.created, &m.updated); err != nil {
			return err
		}
		all = append(all, m)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, m := range all {
		meta := m.meta
		if meta.Valid {
			meta.String = renameJSONKeys(meta.String, map[string]string{"helper": "session", "worker": "session"})
		}
		if _, err := tx.Exec("insert into channel_message (seq, conversation_id, sender_id, kind, body, final, meta, send_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			m.seq, m.conversation, participantID(m.sender), m.kind, m.body, m.final != 0, meta, m.sendKey, m.created, m.updated); err != nil {
			return err
		}
	}
	return nil
}

func copyIssues(tx *sql.Tx, old *sql.DB) error {
	rows, err := rows(old, "select id, title, description, project, agent, priority, rank, parent, blocked_by, plan, step, schedule, created_at, queued_at, closed_at, closed from issue")
	if err != nil {
		return err
	}
	defer rows.Close()
	type issue struct {
		id, title, description string
		project, agent, parent sql.NullString
		priority               string
		rank                   int64
		blockedBy, plan, step  sql.NullString
		schedule               sql.NullInt64
		created                int64
		queued, closedAt       sql.NullInt64
		closed                 sql.NullString
	}
	var all []issue
	for rows.Next() {
		var i issue
		if err := rows.Scan(&i.id, &i.title, &i.description, &i.project, &i.agent, &i.priority, &i.rank, &i.parent,
			&i.blockedBy, &i.plan, &i.step, &i.schedule, &i.created, &i.queued, &i.closedAt, &i.closed); err != nil {
			return err
		}
		if i.priority == "normal" {
			i.priority = "medium"
		}
		if i.closed.Valid {
			i.closed.String = closedReason(i.closed.String)
		}
		all = append(all, i)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, i := range all {
		if _, err := tx.Exec("insert into issue (id, title, description, project, assignee, priority, rank, parent, blocked_by, plan, step, schedule, created_at, queued_at, closed_at, closed) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			i.id, i.title, i.description, i.project, i.agent, i.priority, i.rank, i.parent, i.blockedBy, i.plan, i.step, i.schedule, i.created, i.queued, i.closedAt, i.closed); err != nil {
			return err
		}
	}
	return nil
}

func closedReason(old string) string {
	if old == "harvested" {
		return "merged"
	}
	return old
}

func copyMemories(tx *sql.Tx, old *sql.DB) error {
	rows, err := rows(old, "select id, agent, kind, body, project, helper, created_at, recalled, recalled_at from memories")
	if err != nil {
		return err
	}
	defer rows.Close()
	type memory struct {
		id, created, recalled int64
		agent, kind, body     string
		project, session      sql.NullString
		recalledAt            sql.NullInt64
	}
	var all []memory
	for rows.Next() {
		var m memory
		if err := rows.Scan(&m.id, &m.agent, &m.kind, &m.body, &m.project, &m.session, &m.created, &m.recalled, &m.recalledAt); err != nil {
			return err
		}
		all = append(all, m)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, m := range all {
		if _, err := tx.Exec("insert into memory (id, agent, kind, body, project, session, created_at, recalled, recalled_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			m.id, m.agent, m.kind, m.body, m.project, m.session, m.created, m.recalled, m.recalledAt); err != nil {
			return err
		}
	}
	return nil
}

func copyLedger(tx *sql.Tx, old *sql.DB) error {
	rows, err := rows(old, "select seq, kind, at, payload from ledger")
	if err != nil {
		return err
	}
	defer rows.Close()
	type entry struct {
		seq, at int64
		kind    string
		payload string
	}
	var all []entry
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.seq, &e.kind, &e.at, &e.payload); err != nil {
			return err
		}
		e.payload = renameJSONKeys(e.payload, map[string]string{"helper": "session", "turns": "runs"})
		all = append(all, e)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, e := range all {
		if _, err := tx.Exec("insert into game_ledger (seq, kind, at, payload) values (?, ?, ?, ?)", e.seq, e.kind, e.at, e.payload); err != nil {
			return err
		}
	}
	return nil
}

func copyGate(tx *sql.Tx, old *sql.DB) error {
	var id, open int64
	if err := old.QueryRow("select id, open from lan_gate where id = 1").Scan(&id, &open); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	_, err := tx.Exec("insert into gate (id, open) values (?, ?)", id, open != 0)
	return err
}

func copySchedules(tx *sql.Tx, old *sql.DB) error {
	return copyTable(tx, old,
		"select id, name, body, channel_id, agent, project, spec, tz, enabled, created_at, last_run from schedules",
		func(r *sql.Rows) ([]any, error) {
			var id, channel, enabled, created int64
			var name, body, spec, tz string
			var agent, project sql.NullString
			var last sql.NullInt64
			if err := r.Scan(&id, &name, &body, &channel, &agent, &project, &spec, &tz, &enabled, &created, &last); err != nil {
				return nil, err
			}
			return []any{id, name, body, channel, agent, project, spec, tz, enabled != 0, created, last}, nil
		},
		"insert into schedule (id, name, body, channel_id, agent, project, spec, tz, enabled, created_at, last_run) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
}

func copyConnectors(tx *sql.Tx, old *sql.DB) error {
	if err := copyTable(tx, old,
		"select connector, secrets, owner_id, pair_code, cursor, reply_context, reply_at, last_inbound, paused_until, connected_at, channel_id from connector_accounts",
		func(r *sql.Rows) ([]any, error) {
			var connector, secrets, cursor string
			var owner, pairCode, replyContext sql.NullString
			var replyAt, lastInbound, pausedUntil sql.NullInt64
			var connected int64
			var channel sql.NullInt64
			if err := r.Scan(&connector, &secrets, &owner, &pairCode, &cursor, &replyContext, &replyAt, &lastInbound, &pausedUntil, &connected, &channel); err != nil {
				return nil, err
			}
			return []any{connector, secrets, owner, pairCode, cursor, replyContext, replyAt, lastInbound, pausedUntil, connected, channel}, nil
		},
		"insert into connector_account (connector, secrets, owner_id, pair_code, cursor, reply_context, reply_at, last_inbound, paused_until, connected_at, channel_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"); err != nil {
		return err
	}
	return copyTable(tx, old,
		"select connector, ext_id, message_seq, created_at from connector_inbound",
		func(r *sql.Rows) ([]any, error) {
			var connector, extID string
			var message sql.NullInt64
			var created int64
			if err := r.Scan(&connector, &extID, &message, &created); err != nil {
				return nil, err
			}
			return []any{connector, extID, message, created}, nil
		},
		"insert into connector_inbound (connector, ext_id, message_seq, created_at) values (?, ?, ?, ?)")
}

// importSessions writes a session row for each old step head, its runs, and its events.
func importSessions(tx *sql.Tx, old *sql.DB, home, stepsDir string) error {
	runs := map[string]oldRun{}
	rows, err := rows(old, "select run, issue, started_at from issue_run")
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var r oldRun
		if err := rows.Scan(&id, &r.issue, &r.started); err != nil {
			rows.Close()
			return err
		}
		runs[id] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	entries, err := os.ReadDir(stepsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Join(home, "events"), 0o755); err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".head.json") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(stepsDir, entry.Name()))
		if err != nil {
			return err
		}
		var h oldHead
		if err := json.Unmarshal(body, &h); err != nil {
			return fmt.Errorf("%s: %w", entry.Name(), err)
		}
		if h.ID == "" || h.ID == "foreman" {
			continue
		}
		if err := insertSession(tx, h, runs[h.ID]); err != nil {
			return err
		}
		if err := writeEvents(home, stepsDir, h); err != nil {
			return err
		}
	}
	return nil
}

type oldRun struct {
	issue   string
	started int64
}

type oldHead struct {
	ID        string
	Name      string
	Agent     string
	Runtime   string
	Project   string
	Job       string
	StartedAt int64
	EndedAt   *int64
	Closed    *string
	Outcome   string
	Summary   string
}

func insertSession(tx *sql.Tx, h oldHead, r oldRun) error {
	var issue sql.NullString
	if r.issue != "" {
		issue = sql.NullString{String: r.issue, Valid: true}
	}
	var closed sql.NullString
	if h.Closed != nil {
		closed = sql.NullString{String: closedReason(*h.Closed), Valid: true}
	}
	started := h.StartedAt
	if started == 0 {
		started = r.started
	}
	if _, err := tx.Exec("insert into session (id, agent, name, runtime, task, project, issue, playbook, hired_at, ended_at, closed) values (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)",
		h.ID, h.Agent, h.Name, h.Runtime, h.Job, nullText(h.Project), issue, started, h.EndedAt, closed); err != nil {
		return err
	}
	if r.issue != "" {
		if _, err := tx.Exec("insert into issue_session (session, issue, started_at) values (?, ?, ?)", h.ID, r.issue, started); err != nil {
			return err
		}
		if _, err := tx.Exec("insert into session_run (session, issue, triggered_by, started_at, ended_at, outcome, summary) values (?, ?, ?, ?, ?, ?, ?)",
			h.ID, r.issue, `{"kind":"issue"}`, started, h.EndedAt, nullText(h.Outcome), nullText(h.Summary)); err != nil {
			return err
		}
	}
	return nil
}

func nullText(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// writeEvents turns the old steps (asked, said, thought, tool, …) into today's run/event log.
func writeEvents(home, stepsDir string, h oldHead) error {
	body, err := os.ReadFile(filepath.Join(stepsDir, h.ID+".json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var steps []oldStep
	if err := json.Unmarshal(body, &steps); err != nil {
		return fmt.Errorf("steps/%s.json: %w", h.ID, err)
	}
	events := convertSteps(h, steps)
	out, err := json.Marshal(events)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(home, "events", h.ID+".json"), out, 0o644)
}

type oldStep struct {
	At     int64
	Kind   string
	Text   string
	Action string
	Tool   string
	Input  string
	Output string
	Ok     *bool
}

func convertSteps(h oldHead, steps []oldStep) []protocol.SessionEvent {
	run := int64(1)
	seq := int64(1)
	at := h.StartedAt
	events := []protocol.SessionEvent{{Seq: seq, Time: at, Type: protocol.SessionEventTypeRunStart, Run: &run}}
	next := func(t int64, event protocol.SessionEvent) {
		seq++
		event.Seq, event.Time, event.Run = seq, t, &run
		events = append(events, event)
	}
	for _, s := range steps {
		switch s.Kind {
		case "asked":
			next(s.At, protocol.SessionEvent{Type: protocol.SessionEventTypeUserMessage, Text: s.Text})
		case "said":
			next(s.At, protocol.SessionEvent{Type: protocol.SessionEventTypeAssistantMessage, Text: s.Text})
		case "thought":
			next(s.At, protocol.SessionEvent{Type: protocol.SessionEventTypeAssistantThinking, Text: s.Text})
		case "retry":
			next(s.At, protocol.SessionEvent{Type: protocol.SessionEventTypeLLMRetry, Text: s.Text})
		case "error":
			next(s.At, protocol.SessionEvent{Type: protocol.SessionEventTypeRunError, Text: s.Text})
		case "tool":
			action := toolAction(s.Action)
			tool := s.Tool
			call := protocol.SessionEvent{Type: protocol.SessionEventTypeToolCall, Text: s.Text, Action: &action, Tool: &tool}
			if s.Input != "" {
				input := s.Input
				call.Input = &input
			}
			next(s.At, call)
			callSeq := seq
			result := protocol.SessionEvent{Type: protocol.SessionEventTypeToolResult, Call: &callSeq, Ok: s.Ok}
			if s.Output != "" {
				output := s.Output
				result.Output = &output
			}
			next(s.At, result)
		}
	}
	end := at
	if h.EndedAt != nil {
		end = *h.EndedAt
	}
	outcome := h.Outcome
	if outcome == "" {
		outcome = string(protocol.OutcomeCompleted)
	}
	events = append(events, protocol.SessionEvent{Seq: seq + 1, Time: end, Type: protocol.SessionEventTypeRunEnd, Text: outcome, Run: &run})
	return events
}

func toolAction(action string) protocol.ToolAction {
	switch protocol.ToolAction(action) {
	case protocol.ToolActionRunCommand, protocol.ToolActionReadFile, protocol.ToolActionEditFile,
		protocol.ToolActionSearch, protocol.ToolActionWeb, protocol.ToolActionMCP, protocol.ToolActionWait:
		return protocol.ToolAction(action)
	}
	return protocol.ToolActionOther
}

// renameJSONKeys renames object keys anywhere in a JSON document; a body that is not JSON comes back as it was.
func renameJSONKeys(body string, keys map[string]string) string {
	var v any
	if json.Unmarshal([]byte(body), &v) != nil {
		return body
	}
	changed := false
	var walk func(any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			out := make(map[string]any, len(x))
			for k, e := range x {
				if n, ok := keys[k]; ok {
					k, changed = n, true
				}
				out[k] = walk(e)
			}
			return out
		case []any:
			for i, e := range x {
				x[i] = walk(e)
			}
		}
		return v
	}
	v = walk(v)
	if !changed {
		return body
	}
	out, err := json.Marshal(v)
	if err != nil {
		return body
	}
	return string(out)
}
