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
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agent"
)

// A memory that cannot be read or written never stops a turn: it is logged, and the turn goes on without it. A note the person writes for the manager
// starts with 「主人交代：」, so the manager reading it knows whose it is.

const (
	// In UTF-16 units.
	memoryNoteMax      = 300
	memoryNotesPerTurn = 5
	memoryFromPerson   = "主人交代："
	ManagerAgent       = "foreman"
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
		text := base.ClipLine(found[2], memoryNoteMax)
		if text == "" || slices.ContainsFunc(notes, func(n memoryNote) bool { return n.Text == text }) {
			continue
		}
		notes = append(notes, memoryNote{Text: text, Everywhere: found[1] != ""})
		if len(notes) == memoryNotesPerTurn {
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
	return base.ClipLine(job, 100) + " → " + how + base.ClipLine(summary, 200)
}

func memoryLikeness(a, b map[string]bool) float64 {
	shared := protocol.TermsInCommon(a, b)
	all := len(a) + len(b) - shared
	if all == 0 {
		return 1
	}
	return float64(shared) / float64(all)
}

// project nil: every project.
func memoryIsNewNote(memories []protocol.Memory, text string, project *string) bool {
	terms := protocol.TermsOf(text)
	same := func(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }
	return !slices.ContainsFunc(memories, func(m protocol.Memory) bool {
		return m.Kind == protocol.MemoryKindNote && same(m.Project, project) &&
			(m.Text == text || memoryLikeness(protocol.TermsOf(m.Text), terms) >= 0.8)
	})
}

type Memories struct {
	db  *sql.DB
	now func() int64
}

func newMemories(db *sql.DB) (*Memories, error) { return &Memories{db: db, now: base.NowMs}, nil }
func (*Memories) OnStart(context.Context) error { return nil }
func (*Memories) OnStop()                       {}

func (m *Memories) list(agentID string) ([]protocol.Memory, error) {
	rows, err := m.db.Query(`select id, kind, body, project, helper, created_at, recalled, recalled_at
		from memories where agent = ? order by created_at desc, id desc`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.Memory{}
	for rows.Next() {
		var (
			id, at, recalled int64
			kind, body       string
			project, helper  sql.NullString
			recalledAt       sql.NullInt64
		)
		if err := rows.Scan(&id, &kind, &body, &project, &helper, &at, &recalled, &recalledAt); err != nil {
			return nil, err
		}
		// A row of a kind this code does not know is left out.
		if !slices.Contains(protocol.MemoryKindValues, protocol.MemoryKind(kind)) {
			continue
		}
		mem := protocol.Memory{ID: strconv.FormatInt(id, 10), Agent: agentID, Kind: protocol.MemoryKind(kind), Text: body, At: at, Recalled: recalled}
		if project.Valid {
			mem.Project = &project.String
		}
		if helper.Valid {
			mem.Helper = &helper.String
		}
		if recalledAt.Valid {
			mem.RecalledAt = &recalledAt.Int64
		}
		out = append(out, mem)
	}
	return out, rows.Err()
}

func memoryNullable(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func (m *Memories) insertNote(agentID, body string, project, helper *string) (int64, int64, error) {
	at := base.NowMs()
	res, err := m.db.Exec(`insert into memories (agent, kind, body, project, helper, created_at) values (?, 'note', ?, ?, ?, ?)`,
		agentID, body, memoryNullable(project), memoryNullable(helper), at)
	if err != nil {
		return 0, 0, err
	}
	id, err := res.LastInsertId()
	return id, at, err
}

func (m *Memories) Recall(cue base.RecallCue) []protocol.Memory {
	all, err := m.list(cue.Agent)
	if err != nil {
		log.Printf("vibevalley: %s could not recall: %v", cue.Agent, err)
		return nil
	}
	now := base.NowMs()
	picked := protocol.Pick(all, protocol.Cue{Helper: cue.Helper, Project: cue.Project, Text: cue.Text, Skip: cue.Skip, Now: now})
	for _, p := range picked {
		if _, err := m.db.Exec(`update memories set recalled = recalled + 1, recalled_at = ? where id = ?`, now, p.ID); err != nil {
			log.Printf("vibevalley: %s could not recall: %v", cue.Agent, err)
			return nil
		}
	}
	return picked
}

// A stopped turn leaves nothing.
func (m *Memories) Keep(turn base.FinishedTurn) {
	if turn.Outcome == protocol.OutcomeInterrupted {
		return
	}
	if err := m.keep(turn); err != nil {
		log.Printf("vibevalley: what %s learned was not kept: %v", turn.Helper, err)
	}
}

func (m *Memories) keep(turn base.FinishedTurn) error {
	known, err := m.list(turn.Agent)
	if err != nil {
		return err
	}
	helper := turn.Helper
	for _, note := range memoryNotesOf(turn.Said) {
		var project *string
		if !note.Everywhere {
			project = &turn.Project
		}
		if memoryIsNewNote(known, note.Text, project) {
			if _, _, err := m.insertNote(turn.Agent, note.Text, project, &helper); err != nil {
				return err
			}
		}
	}
	if _, err := m.db.Exec(`insert into memories (agent, kind, body, project, helper, created_at) values (?, 'job', ?, ?, ?, ?)
		on conflict (agent, helper) where kind = 'job'
		do update set body = excluded.body, project = excluded.project, created_at = excluded.created_at`,
		turn.Agent, memoryJobText(turn.Job, turn.Summary, turn.Outcome), turn.Project, turn.Helper, base.NowMs()); err != nil {
		return err
	}
	_, err = m.db.Exec(`delete from memories where agent = ? and id not in (
		select id from memories where agent = ? order by coalesce(recalled_at, created_at) desc limit ?)`,
		turn.Agent, turn.Agent, protocol.MemoryKeep)
	return err
}

func (m *Memories) List(agentID string) []protocol.Memory {
	all, err := m.list(agentID)
	if err != nil {
		log.Printf("vibevalley: memories of %s: %v", agentID, err)
		return []protocol.Memory{}
	}
	return all
}

func (m *Memories) Write(agentID, text, project string) (protocol.Memory, error) {
	body := base.ClipLine(text, memoryNoteMax)
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
	return protocol.Memory{ID: strconv.FormatInt(id, 10), Agent: agentID, Kind: protocol.MemoryKindNote, Text: body, Project: where, At: at}, nil
}

// An id that is not a number is none.
func (m *Memories) Forget(agentID, id string) error {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return nil
	}
	_, err = m.db.Exec(`delete from memories where agent = ? and id = ?`, agentID, n)
	return err
}

func ForemanRuntime() protocol.Runtime {
	if os.Getenv("VIBEVALLEY_FOREMAN_RUNTIME") == string(protocol.RuntimePi) {
		return protocol.RuntimePi
	}
	return protocol.RuntimeVibeValley
}

func ForemanHome(home string) string { return filepath.Join(home, "foreman") }

func memoryLineOf(line agent.MemoryLine, fileTime int64) protocol.Memory {
	person := strings.HasPrefix(line.Text, memoryFromPerson)
	m := protocol.Memory{ID: line.ID, Agent: ManagerAgent, Kind: protocol.MemoryKindNote, Text: line.Text, At: fileTime}
	if person {
		m.Text = strings.TrimSpace(strings.TrimPrefix(line.Text, memoryFromPerson))
	} else {
		helper := ManagerAgent
		m.Helper = &helper
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

type ManagerMemory struct {
	home    string
	runtime protocol.Runtime
}

func newManagerMemory(cfg base.Config) (*ManagerMemory, error) {
	return &ManagerMemory{home: ForemanHome(cfg.Home), runtime: ForemanRuntime()}, nil
}
func (*ManagerMemory) OnStart(context.Context) error { return nil }
func (*ManagerMemory) OnStop()                       {}

func (mm *ManagerMemory) file() string { return filepath.Join(mm.home, "MEMORY.md") }

func (mm *ManagerMemory) fileTime() int64 {
	if st, err := os.Stat(mm.file()); err == nil {
		return st.ModTime().UnixMilli()
	}
	return base.NowMs()
}

func (mm *ManagerMemory) View() protocol.ManagerMemory {
	lines := agent.MemoryLines(mm.home)
	at := mm.fileTime()
	memories := make([]protocol.Memory, len(lines))
	for i, l := range lines {
		memories[len(lines)-1-i] = memoryLineOf(l, at)
	}
	return protocol.ManagerMemory{Runtime: mm.runtime, File: mm.file(), Memories: memories, Carried: int64(memoryCarriedLines(lines))}
}

var memoryNewlines = regexp.MustCompile(`\s*\n\s*`)

func (mm *ManagerMemory) Write(text string) (protocol.Memory, error) {
	body := base.ClipLine(memoryNewlines.ReplaceAllString(text, " "), memoryNoteMax)
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
	return memoryLineOf(lines[len(lines)-1], base.NowMs()), nil
}

func (mm *ManagerMemory) Forget(id string) error { return agent.ForgetLine(mm.home, id) }

func (mm *ManagerMemory) Archive(query string) protocol.ArchiveListing {
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

func (mm *ManagerMemory) ArchiveFile(name string) (string, bool) {
	return agent.ReadArchive(mm.home, name)
}
