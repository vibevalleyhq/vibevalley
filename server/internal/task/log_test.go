package task

import (
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit/fixture"
)

func TestTaskLog(t *testing.T) {
	f, err := newWorldWith(fixture.Config(t.TempDir(), t.TempDir(), ""), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	graph := protocol.TaskGraph{ID: "p1", Title: "打卡", Goal: "做打卡", Project: "demo", State: protocol.GraphStateSplitting, Parallel: 3}
	f.Task.Record(nil, graph, protocol.GraphActorUser, "")
	next := graph
	next.State = protocol.GraphStateAbandoned
	f.Task.Record(&graph, next, protocol.GraphActorSystem, "重启了")
	if _, err := f.DB.Exec("insert into task_event (id, graph_id, kind, actor, created_at) values ('pe-gone', 'p1', 'gone', 'system', 1)"); err != nil {
		t.Fatal(err)
	}
	events := f.Task.List("p1")
	if len(events) != 2 {
		t.Fatalf("events: %+v", events)
	}
	if events[0].Kind != protocol.GraphEventKindSplitting || events[0].Actor != protocol.GraphActorUser || taskStr(events[0].Detail) != "做打卡" {
		t.Fatalf("first: %+v", events[0])
	}
	if events[1].Kind != protocol.GraphEventKindAbandoned || taskStr(events[1].Detail) != "重启了" || events[1].ID <= events[0].ID {
		t.Fatalf("second: %+v", events[1])
	}
	if len(f.Task.List("p2")) != 0 {
		t.Fatal("another task's history")
	}
}
