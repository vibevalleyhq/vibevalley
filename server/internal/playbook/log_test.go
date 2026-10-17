package playbook

import (
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit/fixture"
)

func TestPlaybookLog(t *testing.T) {
	f, err := newWorldWith(fixture.Config(t.TempDir(), t.TempDir(), ""), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	pb := protocol.Playbook{ID: "p1", Title: "打卡", Goal: "做打卡", Project: "demo", State: protocol.PlaybookStatePlanning, Parallel: 3}
	f.Playbook.Record(nil, pb, protocol.PlaybookActorUser, "")
	next := pb
	next.State = protocol.PlaybookStateAbandoned
	f.Playbook.Record(&pb, next, protocol.PlaybookActorSystem, "重启了")
	if _, err := f.DB.Exec("insert into playbook_event (id, playbook_id, kind, actor, created_at) values ('pe-gone', 'p1', 'gone', 'system', 1)"); err != nil {
		t.Fatal(err)
	}
	events := f.Playbook.List("p1")
	if len(events) != 2 {
		t.Fatalf("events: %+v", events)
	}
	if events[0].Kind != protocol.PlaybookEventKindPlanning || events[0].Actor != protocol.PlaybookActorUser || planStr(events[0].Detail) != "做打卡" {
		t.Fatalf("first: %+v", events[0])
	}
	if events[1].Kind != protocol.PlaybookEventKindAbandoned || planStr(events[1].Detail) != "重启了" || events[1].ID <= events[0].ID {
		t.Fatalf("second: %+v", events[1])
	}
	if len(f.Playbook.List("p2")) != 0 {
		t.Fatal("another playbook's history")
	}
}
