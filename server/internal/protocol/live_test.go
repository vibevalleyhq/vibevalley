package protocol

import "testing"

func TestLiveEventKeepsOnlyTheClientsSideEvents(t *testing.T) {
	session := LiveEventSession{At: 1, ID: "w1", Activity: SessionEvent{Seq: 2}}
	for _, e := range []SideEvent{
		{Value: SideEventSessionEvent{At: 1, ID: "w1", SessionEvent: session.Activity}},
		{Value: SideEventNotice{At: 1, Level: NoticeLevelError, Text: "坏了"}},
		{Value: SideEventRuntime{At: 1, Info: RuntimeInfo{ID: "claude"}}},
	} {
		if _, ok := LiveEventOf(e); !ok {
			t.Fatalf("%T should be live", e.Value)
		}
	}
	for _, e := range []SideEvent{
		{Value: FactCall{At: 1}},
		{Value: SideEventSnapshot{At: 1}},
	} {
		if _, ok := LiveEventOf(e); ok {
			t.Fatalf("%T should not be live", e.Value)
		}
	}
}
