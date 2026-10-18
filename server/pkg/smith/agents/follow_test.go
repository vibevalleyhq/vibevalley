package agents

import (
	"context"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

func takeFollowReport(t *testing.T, reports <-chan SubagentReport) SubagentReport {
	t.Helper()
	select {
	case report := <-reports:
		return report
	case <-time.After(3 * time.Second):
		t.Fatal("ordered report did not arrive")
		return SubagentReport{}
	}
}

func TestFollowReportWaitsForWholeFrameIncludingTrailingUsage(t *testing.T) {
	crew := crewOf(t, echo, Options{})
	child := spawned(t, crew, "work", "child")
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	reports := make(chan SubagentReport, 2)
	usage := false
	stop := child.Follow(func(event oar.Event) {
		switch event.Body.(type) {
		case oar.TurnEnded:
			close(entered)
			<-release
		case oar.Usage:
			usage = true
		}
	}, func(report SubagentReport) {
		if !usage {
			t.Error("report overtook usage after TurnEnded in the same frame")
		}
		reports <- report
	})
	defer stop()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("consumer never reached turn end")
	}
	if got := crew.Wait(testCtx(t), WaitOptions{Timeout: time.Second}); len(got) != 1 {
		t.Fatal("blocked consumer stopped legacy report delivery")
	}
	select {
	case <-reports:
		t.Fatal("report bypassed blocked event consumer")
	default:
	}
	once.Do(func() { close(release) })
	if report := takeFollowReport(t, reports); report.Turn != 1 {
		t.Fatalf("report: %+v", report)
	}
}

func TestFollowReplaysEachReportOnceAndThenFollowsLive(t *testing.T) {
	crew := crewOf(t, echo, Options{})
	child := spawned(t, crew, "one", "child")
	if got := crew.Wait(testCtx(t), WaitOptions{Timeout: time.Second}); len(got) != 1 {
		t.Fatal("first report missing")
	}
	reports := make(chan SubagentReport, 4)
	stop := child.Follow(func(oar.Event) {}, func(report SubagentReport) { reports <- report })
	defer stop()
	if got := takeFollowReport(t, reports); got.Turn != 1 {
		t.Fatalf("replay: %+v", got)
	}
	if _, err := child.Send(testCtx(t), "two", "followup"); err != nil {
		t.Fatal(err)
	}
	if got := takeFollowReport(t, reports); got.Turn != 2 {
		t.Fatalf("live: %+v", got)
	}
	select {
	case got := <-reports:
		t.Fatalf("duplicate: %+v", got)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestFollowCancelDoesNotWaitForConsumerOrDeliverReport(t *testing.T) {
	crew := crewOf(t, echo, Options{})
	child := spawned(t, crew, "work", "child")
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	reports := make(chan SubagentReport, 2)
	stop := child.Follow(func(event oar.Event) {
		if _, end := event.Body.(oar.TurnEnded); end {
			close(entered)
			<-release
		}
	}, func(report SubagentReport) { reports <- report })
	defer stop()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("no event")
	}
	stopped := make(chan struct{})
	go func() { stop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("cancel waited on user code")
	}
	once.Do(func() { close(release) })
	select {
	case <-reports:
		t.Fatal("canceled consumer got completion")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestFollowSyntheticCloseReportWaitsForDisposalEvents(t *testing.T) {
	g := &gate{}
	crew := New(Options{Runtimes: registryOf(t, silentOnDispose(oartest.Runtime(oartest.Options{ID: "fake", Turn: g.script})))})
	t.Cleanup(func() { crew.Close(context.Background()) })
	child := spawned(t, crew, "hang", "child")
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	reports := make(chan SubagentReport, 2)
	sawUsage := false
	stop := child.Follow(func(event oar.Event) {
		if _, usage := event.Body.(oar.Usage); usage {
			sawUsage = true
			close(entered)
			<-release
		}
	}, func(report SubagentReport) {
		if !sawUsage {
			t.Error("synthetic report overtook disposal usage")
		}
		reports <- report
	})
	defer stop()
	if err := child.Close(testCtx(t)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("no disposal usage")
	}
	select {
	case <-reports:
		t.Fatal("synthetic report bypassed blocked disposal consumer")
	default:
	}
	once.Do(func() { close(release) })
	if got := takeFollowReport(t, reports); got.Outcome.Kind != "aborted" || got.Turn != 1 {
		t.Fatalf("synthetic: %+v", got)
	}
}
