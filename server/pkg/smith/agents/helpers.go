package agents

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/voyage"
)

// SubagentDepthEnv carries a process's subagent depth to its children.
const SubagentDepthEnv = "OAR_SUBAGENT_DEPTH"

// DefaultWait is how long Wait waits when WaitOptions.Timeout is 0.
const DefaultWait = 30 * time.Second

// hostDepth is this process's depth: OAR_SUBAGENT_DEPTH read as JS Number()
// does, 0 unless a non-negative integer.
func hostDepth() int {
	text := strings.TrimSpace(os.Getenv(SubagentDepthEnv))
	if text == "" {
		return 0
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		parsed, intErr := strconv.ParseInt(text, 0, 64)
		if intErr != nil || strings.ContainsAny(text, "_+-") {
			return 0
		}
		value = float64(parsed)
	}
	if math.IsInf(value, 0) || math.IsNaN(value) || value != math.Trunc(value) || value < 0 {
		return 0
	}
	return int(value)
}

// sessionOf opens a session; an open error comes back as its message.
func sessionOf(ctx context.Context, runtime oar.Runtime, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, string) {
	session, err := runtime.Session(ctx, installation, options)
	if err != nil {
		return nil, err.Error()
	}
	return session, ""
}

// installationOf probes the runtime; a missing installation comes back as a reason.
func installationOf(ctx context.Context, runtime oar.Runtime) (oar.AvailableInstallation, string, error) {
	if runtime.Installation == nil {
		return oar.AvailableInstallation{}, runtime.ID + " exposes no installation probe", nil
	}
	snapshot, err := runtime.Installation(ctx)
	if err != nil {
		return oar.AvailableInstallation{}, "", err
	}
	switch snapshot.Kind {
	case "available":
		return snapshot.Available, "", nil
	case "not_found":
		return oar.AvailableInstallation{}, runtime.ID + " is not installed", nil
	default:
		return oar.AvailableInstallation{}, runtime.ID + " is unsupported: " + snapshot.Reason, nil
	}
}

// logName is a log file name from an id a model may have chosen (`frontend/api`, `../x`):
// every code point outside [A-Za-z0-9_.-] becomes "_".
func logName(id, sessionID string) string {
	var out strings.Builder
	for _, r := range id + "-" + sessionID {
		if r == '_' || r == '.' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			out.WriteRune(r)
		} else {
			out.WriteByte('_')
		}
	}
	return out.String() + ".jsonl"
}

// progress is how far one RawEvents subscription has got: the seq of the
// last record it handled. Go-only: TS observers run inside the append, so
// a record is handled by the time the control that made it returns.
type progress struct {
	mu   sync.Mutex
	seq  int64
	wake chan struct{}
}

func newProgress() *progress { return &progress{seq: -1, wake: make(chan struct{})} }

func (p *progress) done(seq int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if seq > p.seq {
		p.seq = seq
	}
	close(p.wake)
	p.wake = make(chan struct{})
}

// reach waits until the subscription handled seq, or ctx ends.
func (p *progress) reach(ctx context.Context, seq int64) {
	for {
		p.mu.Lock()
		if p.seq >= seq {
			p.mu.Unlock()
			return
		}
		wake := p.wake
		p.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			return
		}
	}
}

// lastSeq is the seq of the session's last record; -1 when none.
func lastSeq(session oar.Session) int64 {
	records := session.Records()
	if len(records) == 0 {
		return -1
	}
	return records[len(records)-1].Seq
}

// attachLog writes the session's records, retained ones first, to file as a voyage log.
func attachLog(session oar.Session, file string, header voyage.Header) (*progress, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return nil, err
	}
	recorder, err := voyage.Open(file, header)
	if err != nil {
		return nil, err
	}
	written := newProgress()
	session.RawEvents(func(record oar.RawEvent) {
		_ = recorder.Record(record)
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
			_ = recorder.End("exited")
		}
		written.done(record.Seq)
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
	return written, nil
}

// sliceUTF16 is JS text.slice(0, n): the first n UTF-16 code units. A cut
// through a surrogate pair leaves JS a lone surrogate; Go has none, so the
// half pair becomes U+FFFD.
func sliceUTF16(text string, n int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= n {
		return text
	}
	return string(utf16.Decode(units[:n]))
}
