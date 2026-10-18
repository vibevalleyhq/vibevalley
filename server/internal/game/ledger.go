package game

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"reflect"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// Entries the farm's facts tell of are recorded here, watching them (entriesFor); the rest where they happen.

type ledger struct {
	q    *generated.Queries
	core *core.Service
	// One entry at a time, so the order in the table is the order of the fold.
	mu      sync.Mutex
	folded  ledgerFolded
	stop    func()
	stopDid func()
}

func newLedger(db *sql.DB, core *core.Service) (*ledger, error) {
	l := &ledger{q: generated.New(db), core: core}
	entries, err := l.entries()
	if err != nil {
		return nil, err
	}
	l.folded = progressFold(entries, emptyFolded())
	core.Apply(protocol.FactProgress{Progress: l.folded.Progress})
	return l, nil
}

// A row this code cannot read any more is left out of the fold.
func (l *ledger) entries() ([]protocol.LedgerEntry, error) {
	rows, err := l.q.LedgerEntries(context.Background())
	if err != nil {
		return nil, err
	}
	out := []protocol.LedgerEntry{}
	for _, row := range rows {
		kind, at, payload := row.Kind, row.At, row.Payload
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
	return out, nil
}

// Against a copy of the core state folded from the same events, to see each fact against what was before it.
func (l *ledger) OnStart(ctx context.Context) error {
	did, stopDid := l.core.OwnerDids().Subscribe()
	l.stopDid = stopDid
	go func() {
		for d := range did {
			switch d.Kind {
			case core.OwnerReviewed:
				l.Record(protocol.LedgerEntryReviewed{Session: d.Session})
			case core.OwnerTalked:
				l.Record(protocol.LedgerEntryMoment{Kind: protocol.LedgerEntryMomentKindVoice})
			}
		}
	}()
	state, events, stop := l.core.Transitions()
	l.stop = stop
	for _, e := range catchUp(state) {
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
				if _, own := event.Fact.Value.(protocol.FactProgress); own {
					continue
				}
				for _, e := range entriesFor(event.Before, event.Fact, event.After) {
					l.Record(e.Value)
				}
			}
		}
	}()
	return nil
}

func (l *ledger) OnStop() {
	if l.stopDid != nil {
		l.stopDid()
	}
	if l.stop != nil {
		l.stop()
	}
}

func taskEntryAt(entry protocol.LedgerEntryValue, at int64) protocol.LedgerEntryValue {
	v := reflect.New(reflect.TypeOf(entry)).Elem()
	v.Set(reflect.ValueOf(entry))
	v.FieldByName("At").SetInt(at)
	return v.Interface().(protocol.LedgerEntryValue)
}

// Called with mu held.
func (l *ledger) write(input protocol.LedgerEntryValue) error {
	at := clock.NowMs()
	entry := protocol.LedgerEntry{Value: taskEntryAt(input, at)}
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
	if err := l.q.AddLedgerEntry(context.Background(), generated.AddLedgerEntryParams{ID: base.NewID(), Kind: kind, At: at, Payload: string(payload)}); err != nil {
		return err
	}
	next, news := progressStep(l.folded, entry)
	l.folded = next
	fact := protocol.FactProgress{Progress: next.Progress}
	if (news.Coins != nil && *news.Coins != 0) || len(news.Unlocked) > 0 {
		fact.News = &news
	}
	l.core.Apply(fact)
	return nil
}

// The ledger must never stop the farm: an entry that cannot be written is logged, and the farm goes on.
func (l *ledger) Record(entry protocol.LedgerEntryValue) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.write(entry); err != nil {
		log.Printf("vibevalley: a ledger entry (%T) was not kept: %v", entry, err)
	}
}

// The title the owner wears: an achievement and its tier; none of either is the plain title.
func (l *ledger) ChooseTitle(achievement *string, tier *int64) {
	entry := protocol.LedgerEntryTitled{}
	if achievement != nil && *achievement != "" {
		entry.Achievement = achievement
	}
	if tier != nil && *tier != 0 {
		entry.Tier = tier
	}
	l.Record(entry)
}
