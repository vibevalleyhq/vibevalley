package core

import (
	"testing"
	"vibevalley/internal/protocol"
)

func TestNarrowStreamsHideSnapshotAndUnrelatedEvents(t *testing.T) {
	s := New(t.TempDir())
	defer s.Close()
	facts, stopFacts := s.Facts()
	defer stopFacts()
	live, stopLive := s.Live()
	defer stopLive()
	s.Apply(protocol.FactCall{State: protocol.CallStateLive})
	s.Notice(protocol.NoticeLevelWarn, "hello")
	if _, ok := (<-facts).Value.(protocol.FactCall); !ok {
		t.Fatal("fact missing")
	}
	if _, ok := (<-live).Value.(protocol.LiveEventNotice); !ok {
		t.Fatal("notice missing")
	}
	select {
	case got := <-facts:
		t.Fatalf("non-fact leaked: %+v", got)
	default:
	}
	select {
	case got := <-live:
		t.Fatalf("fact or snapshot leaked: %+v", got)
	default:
	}
}
