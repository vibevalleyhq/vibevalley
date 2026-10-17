// Package voyage writes and reads the oar-voyage/3 JSONL log format
// (packages/oar/src/voyage.ts).
//
// One JSON object per line, discriminated by `kind`. Line 1 is `header`;
// `record` wraps one RawEvent verbatim (no filtering or re-timestamping:
// human inputs are in the stream already, as request records); `end` is the
// last line; a log without it is a truncated capture. All timestamps are Unix
// epoch milliseconds on the same clock as `receivedAt`. The format is defined
// and owned by oar; other tools may consume it. Rejected response bodies
// carry a typed `code` since 2026-09-23; a log written before then has the
// prose `reason` only. The header carries the requested `effort` since
// 2026-09-29 (absent before, and when none was).
package voyage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Format is the format id every header names.
const Format = "oar-voyage/3"

// VoyageFormat is Format under its TS name (VOYAGE_FORMAT).
const VoyageFormat = Format

// Header is the first line of a log.
type Header struct {
	Runtime string
	// The requested model; "" when none was.
	Model string
	// The reasoning-effort level the run requested (SessionOptions.Effort); "" when none was.
	Effort string
	// Requested native service tier; "" means the runtime chooses.
	ServiceTier string
	Cwd         string
	SessionID   string
	StartedAt   int64
	Recorder    string
}

// marshal is JSON.stringify: no HTML escaping, no trailing newline.
func marshal(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(fmt.Sprintf("voyage: %v", err))
	}
	return string(bytes.TrimSuffix(out.Bytes(), []byte("\n")))
}

// HeaderLine is the header line, keys in the TS order; model, effort and
// serviceTier are omitted when empty.
func HeaderLine(header Header) string {
	return marshal(struct {
		Kind        string `json:"kind"`
		Format      string `json:"format"`
		Runtime     string `json:"runtime"`
		Model       string `json:"model,omitempty"`
		Effort      string `json:"effort,omitempty"`
		ServiceTier string `json:"serviceTier,omitempty"`
		Cwd         string `json:"cwd"`
		SessionID   string `json:"sessionId"`
		StartedAt   int64  `json:"startedAt"`
		Recorder    string `json:"recorder"`
	}{"header", Format, header.Runtime, header.Model, header.Effort, header.ServiceTier, header.Cwd, header.SessionID, header.StartedAt, header.Recorder})
}

// RecordLine wraps one record verbatim.
func RecordLine(record oar.RawEvent) string {
	return marshal(struct {
		Kind   string       `json:"kind"`
		Record oar.RawEvent `json:"record"`
	}{"record", record})
}

// EndLine is the last line of a complete log.
func EndLine(at int64, reason string) string {
	return marshal(struct {
		Kind   string `json:"kind"`
		At     int64  `json:"at"`
		Reason string `json:"reason"`
	}{"end", at, reason})
}

// now is the end line's clock (tests replace it).
var now = func() int64 { return time.Now().UnixMilli() }

// Recorder writes one log. Lines go through unbuffered file writes so their
// order, and everything written so far, survives a crashing process. It is
// safe for concurrent use; End closes the file, and lines after it are
// dropped (TS: a write to the closed fd throws).
type Recorder struct {
	mu   sync.Mutex
	file *os.File
}

// ErrEnded answers a write after End.
var ErrEnded = errors.New("voyage: the log has ended")

// Open creates (truncates) path and writes the header line.
func Open(path string, header Header) (*Recorder, error) {
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	recorder := &Recorder{file: file}
	if err := recorder.write(HeaderLine(header)); err != nil {
		_ = file.Close()
		return nil, err
	}
	return recorder, nil
}

func (r *Recorder) write(line string) error {
	if r.file == nil {
		return ErrEnded
	}
	_, err := r.file.WriteString(line + "\n")
	return err
}

// Record writes one record line.
func (r *Recorder) Record(record oar.RawEvent) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.write(RecordLine(record))
}

// End writes the end line and closes the file; a second End is a no-op.
func (r *Recorder) End(reason string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file == nil {
		return nil
	}
	err := r.write(EndLine(now(), reason))
	closeErr := r.file.Close()
	r.file = nil
	return errors.Join(err, closeErr)
}

// ReadRecords reads the record lines of a voyage log, in order, ignoring the
// header and end lines. Go-only: TS has no reader of its own.
func ReadRecords(reader io.Reader) ([]oar.RawEvent, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 1<<20), 1<<30)
	records := []oar.RawEvent{}
	for line := 1; scanner.Scan(); line++ {
		text := bytes.TrimSpace(scanner.Bytes())
		if len(text) == 0 {
			continue
		}
		var wire struct {
			Kind   string          `json:"kind"`
			Record json.RawMessage `json:"record"`
		}
		if err := json.Unmarshal(text, &wire); err != nil {
			return nil, fmt.Errorf("voyage line %d: %w", line, err)
		}
		if wire.Kind != "record" {
			continue
		}
		var record oar.RawEvent
		if err := json.Unmarshal(wire.Record, &record); err != nil {
			return nil, fmt.Errorf("voyage line %d: %w", line, err)
		}
		records = append(records, record)
	}
	return records, scanner.Err()
}

func (r *Recorder) abort() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.file == nil {
		return nil
	}
	err := r.file.Close()
	r.file = nil
	return err
}
