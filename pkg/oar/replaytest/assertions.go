package replaytest

import (
	"bytes"
	"io/fs"
	"os"
	"strings"
	"testing"

	"github.com/vibevalleyhq/vibevalley/pkg/oar"
)

// AssertCleanArgv verifies that neither Command nor any element of Args contains newlines
// or any forbidden secret/prompt substring.
func AssertCleanArgv(t *testing.T, launch LaunchRecord, forbidden ...string) {
	t.Helper()
	all := append([]string{launch.Spec.Command}, launch.Spec.Args...)
	for i, arg := range all {
		if strings.ContainsAny(arg, "\r\n") {
			t.Fatalf("argv[%d] contains newline characters: %q", i, arg)
		}
		for _, secret := range forbidden {
			if secret != "" && strings.Contains(arg, secret) {
				t.Fatalf("argv[%d] leaked forbidden content %q: %q", i, secret, arg)
			}
		}
	}
}

// AssertSecretFile verifies that a snapped flag file existed at spawn time with exact directory
// and file permissions (e.g. 0700 dir, 0600 file) and contains all required substrings.
func AssertSecretFile(t *testing.T, launch LaunchRecord, flag string, wantDirMode, wantFileMode fs.FileMode, mustContain ...string) FileSnapshot {
	t.Helper()
	snap, ok := launch.FlagFiles[flag]
	if !ok {
		t.Fatalf("missing flag %q in launch args %v", flag, launch.Spec.Args)
	}
	if snap.Err != nil {
		t.Fatalf("snapshot error for %q (%s): %v", flag, snap.Path, snap.Err)
	}
	if !snap.Exists {
		t.Fatalf("file %q for flag %q did not exist at launch time", snap.Path, flag)
	}
	if snap.DirMode != wantDirMode {
		t.Fatalf("dir %q mode = %04o, want %04o", snap.DirPath, snap.DirMode, wantDirMode)
	}
	if snap.Mode != wantFileMode {
		t.Fatalf("file %q mode = %04o, want %04o", snap.Path, snap.Mode, wantFileMode)
	}
	text := string(snap.Content)
	for _, want := range mustContain {
		if !strings.Contains(text, want) {
			t.Fatalf("file %q missing %q; content=%q", snap.Path, want, text)
		}
	}
	return snap
}

// AssertPathRemoved verifies that a temporary directory or file was removed after cleanup/failure.
func AssertPathRemoved(t *testing.T, path string) {
	t.Helper()
	if path == "" {
		return
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected temporary path %q to be removed, stat err=%v", path, err)
	}
}

// AssertEnv verifies an exact environment variable value in the launched process environment.
func AssertEnv(t *testing.T, launch LaunchRecord, key, want string) {
	t.Helper()
	got, ok := launch.EnvMap[key]
	if !ok {
		t.Fatalf("missing env var %q in launched env", key)
	}
	if got != want {
		t.Fatalf("env %q = %q, want %q", key, got, want)
	}
}

// AssertUsageEquals verifies exact incremental token totals (and CostMicros presence/value).
func AssertUsageEquals(t *testing.T, got *oar.TokenTotals, want oar.TokenTotals) {
	t.Helper()
	if got == nil {
		t.Fatalf("got nil TokenTotals, want %+v", want)
	}
	if got.InputTokens != want.InputTokens ||
		got.OutputTokens != want.OutputTokens ||
		got.CacheReadTokens != want.CacheReadTokens ||
		got.CacheWriteTokens != want.CacheWriteTokens ||
		got.ReasoningTokens != want.ReasoningTokens {
		t.Fatalf("tokens = %+v, want %+v", *got, want)
	}
	if want.CostMicros == nil && got.CostMicros != nil {
		t.Fatalf("CostMicros = %d, want nil", *got.CostMicros)
	}
	if want.CostMicros != nil && (got.CostMicros == nil || *got.CostMicros != *want.CostMicros) {
		t.Fatalf("CostMicros = %v, want %d", got.CostMicros, *want.CostMicros)
	}
}

// AssertUsageNil enforces honest unknown-baseline accounting: session Usage() and every emitted
// usage event must leave Tokens as nil rather than reporting cumulative historical spend.
func AssertUsageNil(t *testing.T, sess oar.Session) {
	t.Helper()
	if u := sess.Usage(); u != nil {
		t.Fatalf("sess.Usage() = %+v, want nil on unknown baseline", *u)
	}
	for _, rec := range sess.Records() {
		for _, ev := range rec.Events {
			if ev.Kind == oar.EventUsage && ev.Usage != nil && ev.Usage.Tokens != nil {
				t.Fatalf("record seq %d emitted non-nil usage tokens %+v on unknown baseline", rec.Seq, *ev.Usage.Tokens)
			}
		}
	}
}

// AssertVoyageRoundTrip encodes records into oar-voyage/3 JSONL, checks root agentPath [] encoding,
// decodes back, and verifies monotonic seq and lossless raw bytes.
func AssertVoyageRoundTrip(t *testing.T, header oar.VoyageHeader, records []oar.RecordEnvelope) []oar.RecordEnvelope {
	t.Helper()
	var buf bytes.Buffer
	if err := oar.EncodeVoyage(&buf, header, records); err != nil {
		t.Fatalf("EncodeVoyage: %v", err)
	}
	encoded := buf.String()
	lines := strings.Split(strings.TrimSpace(encoded), "\n")
	if len(lines) != len(records)+1 {
		t.Fatalf("voyage line count = %d, want %d", len(lines), len(records)+1)
	}
	if !strings.Contains(lines[0], `"format":"oar-voyage/3"`) {
		t.Fatalf("voyage header missing oar-voyage/3 format: %s", lines[0])
	}
	for i, rec := range records {
		if len(rec.AgentPath) == 0 && !strings.Contains(lines[i+1], `"agentPath":[]`) {
			t.Fatalf("record %d encoded root agentPath without []: %s", i, lines[i+1])
		}
	}

	gotHdr, decoded, err := oar.DecodeVoyage(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("DecodeVoyage: %v", err)
	}
	if gotHdr.Format != oar.VoyageFormat {
		t.Fatalf("decoded header format = %q, want %q", gotHdr.Format, oar.VoyageFormat)
	}
	if len(decoded) != len(records) {
		t.Fatalf("decoded count = %d, want %d", len(decoded), len(records))
	}
	var prevSeq int64 = -1
	for i, got := range decoded {
		want := records[i]
		if got.Seq != want.Seq || got.Seq <= prevSeq {
			t.Fatalf("record[%d].Seq = %d (prev %d), want %d", i, got.Seq, prevSeq, want.Seq)
		}
		prevSeq = got.Seq
		if got.SessionID != want.SessionID {
			t.Fatalf("record[%d].SessionID = %q, want %q", i, got.SessionID, want.SessionID)
		}
		if got.SpanID != want.SpanID {
			t.Fatalf("record[%d].SpanID = %q, want %q", i, got.SpanID, want.SpanID)
		}
		if got.AgentPath == nil {
			t.Fatalf("record[%d].AgentPath decoded as nil; root must be non-nil []", i)
		}
		if !bytes.Equal(got.Raw, want.Raw) {
			t.Fatalf("record[%d].Raw = %x, want lossless %x", i, got.Raw, want.Raw)
		}
	}
	return decoded
}
