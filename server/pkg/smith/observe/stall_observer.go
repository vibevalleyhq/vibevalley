package observe

import (
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
)

// StallInfo is a silent active turn (observe/stall-observer.ts).
type StallInfo struct {
	SinceSeq    int64 `json:"sinceSeq"`
	SilentForMs int64 `json:"silentForMs"`
	// Kind of the last folded record, with the frame's last event kind when it had one (frame:tool_call_started).
	LastRecordKind string `json:"lastRecordKind"`
}

// StallOptions for ObserveStalls.
type StallOptions struct {
	StallAfter time.Duration
	OnStall    func(StallInfo)
}

// ObserveStalls is a convenience layer over the public status reducer: it
// folds the session's records with ReduceStatus, asks StallOf with the wall
// clock, and reports when an active turn has been silent for StallAfter.
// There is deliberately no second state machine; the reducer is the single
// source of truth. It fires once per silence episode; the next record
// re-arms it. The embedder decides what a stall means.
func ObserveStalls(session oar.Session, options StallOptions) oar.Unsubscribe {
	var mu sync.Mutex
	status := InitialStatus
	lastRecordKind := ""
	var timer *time.Timer
	generation := 0
	stopped := false

	disarm := func() {
		if timer != nil {
			timer.Stop()
			timer = nil
		}
		generation++
	}
	arm := func() {
		disarm()
		mine := generation
		timer = time.AfterFunc(options.StallAfter, func() {
			mu.Lock()
			if stopped || mine != generation {
				mu.Unlock()
				return
			}
			stall := StallOf(status, time.Now().UnixMilli(), options.StallAfter.Milliseconds())
			info := StallInfo{LastRecordKind: lastRecordKind}
			mu.Unlock()
			if stall != nil {
				info.SinceSeq, info.SilentForMs = stall.SinceSeq, stall.SilentForMs
				options.OnStall(info)
			}
		})
	}

	unsubscribe := session.RawEvents(func(record oar.RawEvent) {
		mu.Lock()
		defer mu.Unlock()
		if stopped {
			return
		}
		status = ReduceStatus(status, record, session.ID())
		lastRecordKind = string(record.Kind)
		if record.Kind == oar.KindFrame && len(record.Frame.Events) > 0 {
			lastRecordKind = "frame:" + record.Frame.Events[len(record.Frame.Events)-1].EventKind()
		}
		if status.IsRunning() {
			arm()
		} else {
			disarm()
		}
	}, nil)

	return func() {
		mu.Lock()
		stopped = true
		disarm()
		mu.Unlock()
		unsubscribe()
	}
}
