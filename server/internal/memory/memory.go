package memory

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agent"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// A memory that cannot be read or written never stops a run: it is logged, and the run goes on without it. A note the person writes for the manager
// starts with 「主人交代：」, so the manager reading it knows whose it is.

const (
	// In UTF-16 units.
	memoryNoteMax     = 300
	memoryNotesPerRun = 5
	memoryFromPerson  = "主人交代："
)

// A list mark or bold around it is fine.
var memoryNoteLine = regexp.MustCompile(`^[\s\pZ]*(?:[-*•][\s\pZ]*)?(?:\*\*)?记住(（所有项目）|\(所有项目\))?(?:\*\*)?[\s\pZ]*[:：][\s\pZ]*(?:\*\*)?[\s\pZ]*(.+?)[\s\pZ]*$`)

type memoryNote struct {
	Text       string
	Everywhere bool
}

func memoryNotesOf(said string) []memoryNote {
	var notes []memoryNote
	for _, line := range strings.Split(said, "\n") {
		found := memoryNoteLine.FindStringSubmatch(line)
		if found == nil {
			continue
		}
		text := str.Clip(found[2], memoryNoteMax)
		if text == "" || slices.ContainsFunc(notes, func(n memoryNote) bool { return n.Text == text }) {
			continue
		}
		notes = append(notes, memoryNote{Text: text, Everywhere: found[1] != ""})
		if len(notes) == memoryNotesPerRun {
			break
		}
	}
	return notes
}

func memoryJobText(job, summary string, outcome protocol.Outcome) string {
	how := ""
	if outcome != protocol.OutcomeCompleted {
		how = "没做成："
	}
	return str.Clip(job, 100) + " → " + how + str.Clip(summary, 200)
}

func memoryLikeness(a, b map[string]bool) float64 {
	shared := termsInCommon(a, b)
	all := len(a) + len(b) - shared
	if all == 0 {
		return 0
	}
	return float64(shared) / float64(all)
}

// project nil: every project.
func memoryIsNewNote(memories []protocol.Memory, text string, project *string) bool {
	terms := termsOf(text)
	same := func(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }
	return !slices.ContainsFunc(memories, func(m protocol.Memory) bool {
		return m.Kind == protocol.MemoryKindNote && same(m.Project, project) &&
			(m.Text == text || memoryLikeness(termsOf(m.Text), terms) >= 0.8)
	})
}

type memories struct {
	db  *sql.DB
	q   *generated.Queries
	now func() int64
}

func newMemories(db *sql.DB) (*memories, error) {
	return &memories{db: db, q: generated.New(db), now: clock.NowMs}, nil
}
func (*memories) OnStart(context.Context) error { return nil }
func (*memories) OnStop()                       {}

func (m *memories) list(agentID string) ([]protocol.Memory, error) {
	rows, err := m.q.MemoriesOf(context.Background(), agentID)
	if err != nil {
		return nil, err
	}
	out := []protocol.Memory{}
	for _, row := range rows {
		id, at, recalled, kind, body := row.ID, row.CreatedAt, row.Recalled, row.Kind, row.Body
		project, session, recalledAt := row.Project, row.Session, row.RecalledAt
		// A row of a kind this code does not know is left out.
		if !slices.Contains(protocol.MemoryKindValues, protocol.MemoryKind(kind)) {
			continue
		}
		mem := protocol.Memory{ID: id, Agent: agentID, Kind: protocol.MemoryKind(kind), Text: body, At: at, Recalled: recalled}
		if project.Valid {
			mem.Project = &project.String
		}
		if session.Valid {
			mem.Session = &session.String
		}
		if recalledAt.Valid {
			mem.RecalledAt = &recalledAt.Int64
		}
		out = append(out, mem)
	}
	return out, nil
}

func memoryNullable(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func (m *memories) insertNote(agentID, body string, project, session *string) (string, int64, error) {
	at := clock.NowMs()
	id := base.NewID()
	_, err := m.q.AddNote(context.Background(), generated.AddNoteParams{ID: id, Agent: agentID, Body: body, Project: memoryNullable(project), Session: memoryNullable(session), CreatedAt: at})
	if err != nil {
		return "", 0, err
	}
	return id, at, nil
}

// What a run would recall, as recall.go picks it; nothing is counted as recalled until markRecalled.
func (m *memories) recallable(cue RecallCue) []protocol.Memory {
	all, err := m.list(cue.Agent)
	if err != nil {
		log.Printf("vibevalley: %s could not recall: %v", cue.Agent, err)
		return nil
	}
	return pick(all, pickCue{Session: cue.Session, Project: cue.Project, Text: cue.Text, Skip: cue.Skip, Now: clock.NowMs()})
}

func (m *memories) markRecalled(ids []string) {
	now := sql.NullInt64{Int64: clock.NowMs(), Valid: true}
	for _, id := range ids {
		if err := m.q.Recalled(context.Background(), generated.RecalledParams{RecalledAt: now, ID: id}); err != nil {
			log.Printf("vibevalley: a memory was recalled but not marked: %v", err)
			return
		}
	}
}

// A stopped run leaves nothing.
func (m *memories) Keep(run FinishedRun) {
	if run.Outcome == protocol.OutcomeInterrupted {
		return
	}
	if err := m.keep(run); err != nil {
		log.Printf("vibevalley: what %s learned was not kept: %v", run.Session, err)
	}
}

func (m *memories) keep(run FinishedRun) error {
	tx, err := m.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Reading for deduplication, keeping notes and pruning are one durable change.
	m = &memories{q: generated.New(tx), now: m.now}
	known, err := m.list(run.Agent)
	if err != nil {
		return err
	}
	session := run.Session
	for _, note := range memoryNotesOf(run.Said) {
		var project *string
		if !note.Everywhere {
			project = &run.Project
		}
		if memoryIsNewNote(known, note.Text, project) {
			if _, _, err := m.insertNote(run.Agent, note.Text, project, &session); err != nil {
				return err
			}
			known = append(known, protocol.Memory{Kind: protocol.MemoryKindNote, Text: note.Text, Project: project})
		}
	}
	ctx := context.Background()
	if err := m.q.KeepJob(ctx, generated.KeepJobParams{
		ID: base.NewID(), Agent: run.Agent, Body: memoryJobText(run.Job, run.Summary, run.Outcome), Project: sql.NullString{String: run.Project, Valid: true},
		Session: sql.NullString{String: run.Session, Valid: true}, CreatedAt: clock.NowMs(),
	}); err != nil {
		return err
	}
	all, err := m.list(run.Agent)
	if err != nil {
		return err
	}
	for _, id := range nextForgotten(all, 0) {
		if err := m.q.Forget(ctx, generated.ForgetParams{Agent: run.Agent, ID: id}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Fading marks the ones that would go if this many more were kept.
const memoryFadingSoon = 10

func (m *memories) List(agentID string) []protocol.Memory {
	all, err := m.list(agentID)
	if err != nil {
		log.Printf("vibevalley: memories of %s: %v", agentID, err)
		return []protocol.Memory{}
	}
	fading := nextForgotten(all, memoryFadingSoon)
	for i := range all {
		all[i].Fading = slices.Contains(fading, all[i].ID)
	}
	return all
}

func (m *memories) Write(agentID, text, project string) (protocol.Memory, error) {
	body := str.Clip(text, memoryNoteMax)
	if body == "" {
		return protocol.Memory{}, errors.New("要记的话是空的")
	}
	var where *string
	if p := strings.TrimSpace(project); p != "" {
		where = &p
	}
	id, at, err := m.insertNote(agentID, body, where, nil)
	if err != nil {
		log.Printf("vibevalley: a note for %s: %v", agentID, err)
		return protocol.Memory{}, errors.New("没记下来：数据库写不进去")
	}
	return protocol.Memory{ID: id, Agent: agentID, Kind: protocol.MemoryKindNote, Text: body, Project: where, At: at}, nil
}

func (m *memories) Forget(agentID, id string) error {
	return m.q.Forget(context.Background(), generated.ForgetParams{Agent: agentID, ID: id})
}

func ManagerHome(home string) string { return filepath.Join(home, "manager") }

func memoryLineOf(line agent.MemoryLine, fileTime int64) protocol.Memory {
	person := strings.HasPrefix(line.Text, memoryFromPerson)
	m := protocol.Memory{ID: line.ID, Agent: protocol.ManagerAgent, Kind: protocol.MemoryKindNote, Text: line.Text, At: fileTime}
	if person {
		m.Text = strings.TrimSpace(strings.TrimPrefix(line.Text, memoryFromPerson))
	} else {
		session := protocol.ManagerAgent
		m.Session = &session
	}
	if line.Date != "" {
		if day, err := time.ParseInLocation("2006-01-02", line.Date, time.Local); err == nil {
			m.At = day.UnixMilli()
		}
	}
	return m
}

// memoryCarriedLines is how many of the newest lines the system prompt carries: agent.ReadMemory keeps the last
// MEMORY_PROMPT_CHARS characters.
func memoryCarriedLines(lines []agent.MemoryLine) int {
	chars, n := 0, 0
	for i := len(lines) - 1; i >= 0; i-- {
		line := "- " + lines[i].Text + "\n"
		if lines[i].Date != "" {
			line = "- " + lines[i].Date + " " + lines[i].Text + "\n"
		}
		chars += utf8.RuneCountInString(line)
		if chars > agent.MEMORY_PROMPT_CHARS {
			break
		}
		n++
	}
	return n
}

type managerMemory struct {
	home string
}

func newManagerMemory(cfg base.Config) (*managerMemory, error) {
	return &managerMemory{home: ManagerHome(cfg.Home)}, nil
}
func (*managerMemory) OnStart(context.Context) error { return nil }
func (*managerMemory) OnStop()                       {}

func (mm *managerMemory) file() string { return agent.MemoryFile(mm.home) }

func (mm *managerMemory) fileTime() int64 {
	if st, err := os.Stat(mm.file()); err == nil {
		return st.ModTime().UnixMilli()
	}
	return clock.NowMs()
}

func (mm *managerMemory) Manager() protocol.MemoryList {
	lines := agent.MemoryLines(mm.home)
	at := mm.fileTime()
	memories := make([]protocol.Memory, len(lines))
	for i, l := range lines {
		memories[len(lines)-1-i] = memoryLineOf(l, at)
	}
	file, carried := mm.file(), int64(memoryCarriedLines(lines))
	return protocol.MemoryList{File: &file, Memories: memories, Carried: &carried, Sources: []protocol.MemorySourceInfo{}}
}

var memoryNewlines = regexp.MustCompile(`\s*\n\s*`)

func (mm *managerMemory) WriteManager(text string) (protocol.Memory, error) {
	body := str.Clip(memoryNewlines.ReplaceAllString(text, " "), memoryNoteMax)
	if body == "" {
		return protocol.Memory{}, errors.New("要记的话是空的")
	}
	if err := agent.Remember(mm.home, memoryFromPerson+body, time.Now()); err != nil {
		return protocol.Memory{}, errors.New("没记下来：MEMORY.md 写不进去")
	}
	lines := agent.MemoryLines(mm.home)
	if len(lines) == 0 {
		return protocol.Memory{}, errors.New("没记下来：MEMORY.md 写不进去")
	}
	return memoryLineOf(lines[len(lines)-1], clock.NowMs()), nil
}

func (mm *managerMemory) ForgetManager(id string) error { return agent.ForgetLine(mm.home, id) }

func (mm *managerMemory) Archive(query string) protocol.ArchiveListing {
	listing := protocol.ArchiveListing{Files: []protocol.ArchiveFile{}, Hits: []protocol.ArchiveHit{}}
	for _, f := range agent.ArchiveFiles(mm.home) {
		listing.Files = append(listing.Files, protocol.ArchiveFile{Name: f.Name, At: f.At, Chars: int64(f.Chars)})
	}
	if strings.TrimSpace(query) != "" {
		for _, h := range agent.SearchArchive(mm.home, query, 0) {
			listing.Hits = append(listing.Hits, protocol.ArchiveHit{File: h.File, Line: int64(h.Line), Text: h.Text})
		}
	}
	return listing
}

func (mm *managerMemory) ArchiveFile(name string) (string, bool) {
	return agent.ReadArchive(mm.home, name)
}
