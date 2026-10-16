package game

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"reflect"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// The farm's ledger (ported from the TypeScript server's ledger.ts, removed): the things worth remembering (work harvested, turns failed,
// conflicts, the person's words for a helper, …), kept in the ledger table in order. Coins, streaks and achievements
// are what it folds into (protocol progress.go): the whole ledger at start, into the core state's progress, then one
// entry at a time, each a progress fact with what it brought. Entries the farm's facts tell of are recorded here,
// watching them (protocol.EntriesFor); the rest where they happen (a harvest, words on the chat, a voice call).
// Rationale: .agents/notes/implemented/feature/2026-10-11-achievements.md.

type Ledger struct {
	db   *sql.DB
	site *base.Site
	// mu: one entry at a time, so the order in the table is the order of the fold.
	mu     sync.Mutex
	folded protocol.Folded
	stop   func()
}

func newLedger(db *sql.DB, site *base.Site) (*Ledger, error) {
	l := &Ledger{db: db, site: site}
	entries, err := l.entries()
	if err != nil {
		return nil, err
	}
	l.folded = protocol.ProgressFold(entries, protocol.EmptyFolded())
	site.Apply(protocol.FactProgress{Progress: l.folded.Progress})
	return l, nil
}

// entries is the ledger in order; a row this code cannot read any more is left out of the fold.
func (l *Ledger) entries() ([]protocol.LedgerEntry, error) {
	rows, err := l.db.Query("select kind, at, payload from ledger order by seq")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.LedgerEntry{}
	for rows.Next() {
		var kind, payload string
		var at int64
		if err := rows.Scan(&kind, &at, &payload); err != nil {
			return nil, err
		}
		fields := map[string]any{}
		if err := json.Unmarshal([]byte(payload), &fields); err != nil || fields == nil {
			fields = map[string]any{}
		}
		fields["kind"], fields["at"] = kind, at
		body, _ := json.Marshal(fields)
		var entry protocol.LedgerEntry
		if err := json.Unmarshal(body, &entry); err != nil || entry.Value == nil {
			continue
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

// start follows the farm's facts, against a copy of the core state folded from the same events, to see each fact
// against what was before it.
func (l *Ledger) OnStart(ctx context.Context) error {
	snapshot, events, stop := l.site.Events()
	l.stop = stop
	state := snapshot.Value.(protocol.SiteEventSnapshot).State
	for _, e := range protocol.CatchUp(state) {
		l.Record(e.Value)
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				fact, isFact := event.Value.(protocol.FactValue)
				if !isFact {
					continue
				}
				before := state
				state, _ = protocol.Reduce(before, protocol.Fact{Value: fact})
				// Its own progress facts are no news to it.
				if _, own := fact.(protocol.FactProgress); own {
					continue
				}
				for _, e := range protocol.EntriesFor(before, protocol.Fact{Value: fact}, state) {
					l.Record(e.Value)
				}
			}
		}
	}()
	return nil
}

func (l *Ledger) OnStop() {
	if l.stop != nil {
		l.stop()
	}
}

// planEntryAt is an entry with its time set: every ledger entry has an At field.
func planEntryAt(entry protocol.LedgerEntryValue, at int64) protocol.LedgerEntryValue {
	v := reflect.New(reflect.TypeOf(entry)).Elem()
	v.Set(reflect.ValueOf(entry))
	v.FieldByName("At").SetInt(at)
	return v.Interface().(protocol.LedgerEntryValue)
}

// write keeps an entry and folds it in. Called with mu held.
func (l *Ledger) write(input protocol.LedgerEntryValue) error {
	at := base.NowMs()
	entry := protocol.LedgerEntry{Value: planEntryAt(input, at)}
	body, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	fields := map[string]any{}
	if err := json.Unmarshal(body, &fields); err != nil {
		return err
	}
	kind, _ := fields["kind"].(string)
	delete(fields, "kind")
	delete(fields, "at")
	payload, _ := json.Marshal(fields)
	if _, err := l.db.Exec("insert into ledger (kind, at, payload) values (?, ?, ?)", kind, at, string(payload)); err != nil {
		return err
	}
	next, news := protocol.ProgressStep(l.folded, entry)
	l.folded = next
	fact := protocol.FactProgress{Progress: next.Progress}
	if (news.Coins != nil && *news.Coins != 0) || len(news.Unlocked) > 0 {
		fact.News = &news
	}
	l.site.Apply(fact)
	return nil
}

// Record writes an entry on the ledger (its At is now) and folds the progress. The ledger must never stop the farm:
// an entry that cannot be written is logged, and the farm goes on.
func (l *Ledger) Record(entry protocol.LedgerEntryValue) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.write(entry); err != nil {
		log.Printf("vibevalley: a ledger entry (%T) was not kept: %v", entry, err)
	}
}

// Carry brings coins over from a page's old progress, once; whether it did.
func (l *Ledger) Carry(coins int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if coins <= 0 {
		return false
	}
	var n int
	if err := l.db.QueryRow("select count(*) from ledger where kind = 'carried'").Scan(&n); err != nil || n > 0 {
		return false
	}
	if err := l.write(protocol.LedgerEntryCarried{Coins: coins}); err != nil {
		log.Printf("vibevalley: carried coins were not kept: %v", err)
		return false
	}
	return true
}
