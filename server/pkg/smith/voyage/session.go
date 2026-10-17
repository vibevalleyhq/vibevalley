package voyage

import (
	"context"
	"errors"
	"sync"

	"vibevalley/pkg/smith/oar"
)

// SessionRecording owns cursor replay, ordered writes and the recording's completion barrier.
// Go observers are asynchronous (unlike voyage.ts); Close waits for the session's current tail before ending the log.
type SessionRecording struct {
	session     oar.Session
	recorder    *Recorder
	unsubscribe oar.Unsubscribe
	reason      string
	mu          sync.Mutex
	seq         int64
	wake        chan struct{}
	err         error
	ended       bool
	closed      bool
}

func Attach(path string, session oar.Session, header Header, reason string) (*SessionRecording, error) {
	header.SessionID = session.ID()
	recorder, err := Open(path, header)
	if err != nil {
		return nil, err
	}
	r := &SessionRecording{session: session, recorder: recorder, reason: reason, seq: -1, wake: make(chan struct{})}
	r.unsubscribe = session.RawEvents(r.record, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
	r.mu.Lock()
	err = r.err
	r.mu.Unlock()
	if err != nil {
		return nil, errors.Join(err, r.Close(context.Background()))
	}
	return r, nil
}

func (r *SessionRecording) record(record oar.RawEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.ended || r.err != nil {
		return
	}
	r.err = r.recorder.Record(record)
	if r.err == nil && record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
		r.err = r.recorder.End(r.reason)
		r.ended = true
	}
	r.seq = record.Seq
	close(r.wake)
	r.wake = make(chan struct{})
}

func (r *SessionRecording) wait(ctx context.Context, target int64) error {
	for {
		r.mu.Lock()
		err, seq, ended, wake := r.err, r.seq, r.ended, r.wake
		r.mu.Unlock()
		if err != nil {
			return err
		}
		if seq >= target {
			return nil
		}
		if ended {
			return ErrEnded
		}
		select {
		case <-wake:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Close leaves a truncated capture on a write error or timeout, never a misleading end marker.
func (r *SessionRecording) Close(ctx context.Context) error {
	records := r.session.Records()
	target := int64(-1)
	if len(records) > 0 {
		target = records[len(records)-1].Seq
	}
	err := r.wait(ctx, target)
	r.unsubscribe()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.err
	}
	r.closed = true
	r.err = errors.Join(r.err, err)
	if r.err == nil {
		r.err = r.recorder.End(r.reason)
	} else {
		r.err = errors.Join(r.err, r.recorder.abort())
	}
	r.ended = true
	close(r.wake)
	return r.err
}
