package shared

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"vibevalley/pkg/smith/oar"
)

// Mechanisms every login driver shares: reading what a vendor login command
// prints, keeping secrets out of what oar reports, and the deadline and
// cancellation rules of the contract (shared/login.ts).
//
// Not ported: spawnLoginProcess (a login command over three pipes in its
// own process group, both streams read line by line with partial-line
// callbacks, SIGTERM then SIGKILL to the group). internal/executable's
// LineProcess reads only stdout lines and keeps a stderr tail, and its
// process-group helpers are unexported. ReadLoginStream is the reading half.

// OSC (hyperlinks, titles) ends with BEL or ESC \; CSI (colors, cursor moves)
// ends with a final byte in @-~; any other escape is ESC, optional
// intermediates (a charset choice: ESC ( B), and one final byte.
var terminalEscapes = regexp.MustCompile(`\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]`)

// StripTerminalEscapes removes terminal escapes: colors, cursor movement,
// and OSC 8 hyperlinks (their visible text stays).
func StripTerminalEscapes(text string) string {
	return terminalEscapes.ReplaceAllString(text, "")
}

var tokenShapes = []*regexp.Regexp{
	regexp.MustCompile(`\bsk-[\w-]{16,}`),             // Anthropic and OpenAI keys and OAuth tokens
	regexp.MustCompile(`\beyJ[\w-]+\.[\w-]+\.[\w-]+`), // JWTs
}

const (
	secretMinLength = 6
	detailLimit     = 500
)

// utf16Len is a string's JavaScript length.
func utf16Len(text string) int {
	count := 0
	for _, r := range text {
		if r > 0xFFFF {
			count += 2
		} else {
			count++
		}
	}
	return count
}

// LoginSecrets holds values that must never leave a login: the codes a
// person pasted, and any token-shaped text. Everything oar reports from
// runtime output goes through Redact. Not safe for concurrent use.
type LoginSecrets struct {
	values []string
	known  map[string]bool
}

// Add remembers a secret; values too short to be secret on their own (a
// separator, a single word) are ignored.
func (s *LoginSecrets) Add(value string) {
	if utf16Len(value) < secretMinLength {
		return
	}
	if s.known == nil {
		s.known = map[string]bool{}
	}
	if !s.known[value] {
		s.known[value] = true
		s.values = append(s.values, value)
	}
}

// Redact replaces the secrets (longest first, so a whole code is replaced
// before any of its parts) and token shapes, and bounds the length to 500
// characters plus "...".
func (s *LoginSecrets) Redact(text string) string {
	values := append([]string(nil), s.values...)
	sort.SliceStable(values, func(i, j int) bool { return utf16Len(values[i]) > utf16Len(values[j]) })
	redacted := text
	for _, value := range values {
		redacted = strings.ReplaceAll(redacted, value, "[redacted]")
	}
	for _, shape := range tokenShapes {
		redacted = shape.ReplaceAllString(redacted, "[redacted]")
	}
	if utf16Len(redacted) > detailLimit {
		return headUTF16(redacted, detailLimit) + "..."
	}
	return redacted
}

var lineBreak = regexp.MustCompile(`\r?\n`)

// Line is the first non-blank line of text, redacted: a runtime's one-line
// reason, never a log tail.
func (s *LoginSecrets) Line(text string) string {
	for _, line := range lineBreak.Split(text, -1) {
		if trimmed := jsTrim(line); trimmed != "" {
			return s.Redact(trimmed)
		}
	}
	return s.Redact("")
}

// ErrorMessage is an error's message.
func ErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// LoginStream names a login command's output stream.
type LoginStream string

const (
	LoginStdout LoginStream = "stdout"
	LoginStderr LoginStream = "stderr"
)

// LoginOutputHandlers receive what a login command prints.
type LoginOutputHandlers struct {
	// One complete line from either stream, escapes stripped and trimmed; blank lines are skipped.
	OnLine func(line string, stream LoginStream)
	// A stream's unterminated tail after each chunk, escapes stripped: a
	// prompt printed with no newline. May be nil.
	OnPartial func(text string, stream LoginStream)
}

// LoginProcessExit is how a login command ended.
type LoginProcessExit struct {
	ExitCode *int
	Signal   string
	// The spawn error, when the command could not start.
	Error string
}

const partialLimit = 64 * 1024

var lineBreaks = regexp.MustCompile(`\r\n|\n|\r`)

// tailUTF16 is text.slice(-units) in UTF-16 code units, never splitting a character.
func tailUTF16(text string, units int) string {
	if utf16Len(text) <= units {
		return text
	}
	count := 0
	index := len(text)
	for index > 0 {
		r, size := utf8.DecodeLastRuneInString(text[:index])
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if count+width > units {
			break
		}
		count += width
		index -= size
	}
	return text[index:]
}

// completeUTF8 splits off an incomplete UTF-8 sequence at the end of data,
// as a StringDecoder holds it for the next chunk.
func completeUTF8(data []byte) (complete, rest []byte) {
	for back := 1; back <= 3 && back <= len(data); back++ {
		start := len(data) - back
		if !utf8.RuneStart(data[start]) {
			continue
		}
		if !utf8.FullRune(data[start:]) {
			return data[:start], data[start:]
		}
		break
	}
	return data, nil
}

// ReadLoginStream reads one output stream of a login command until EOF (or
// a read error): each complete line (split on \r\n, \n or \r), escapes
// stripped and trimmed, goes to OnLine unless blank; after each chunk the
// unterminated tail (at most 64 KiB), escapes stripped, goes to OnPartial;
// at the end the tail is a last line.
func ReadLoginStream(r io.Reader, stream LoginStream, handlers LoginOutputHandlers) {
	var pending []byte
	buffer := ""
	chunk := make([]byte, 32*1024)
	for {
		n, err := r.Read(chunk)
		if n > 0 {
			complete, rest := completeUTF8(append(pending, chunk[:n]...))
			pending = append([]byte(nil), rest...)
			buffer += strings.ToValidUTF8(string(complete), "�")
			lines := lineBreaks.Split(buffer, -1)
			buffer = tailUTF16(lines[len(lines)-1], partialLimit)
			for _, raw := range lines[:len(lines)-1] {
				if line := jsTrim(StripTerminalEscapes(raw)); line != "" {
					handlers.OnLine(line, stream)
				}
			}
			if buffer != "" && handlers.OnPartial != nil {
				handlers.OnPartial(StripTerminalEscapes(buffer), stream)
			}
		}
		if err != nil {
			break
		}
	}
	tail := buffer + strings.ToValidUTF8(string(bytes.Clone(pending)), "�")
	if line := jsTrim(StripTerminalEscapes(tail)); line != "" {
		handlers.OnLine(line, stream)
	}
}

// LoginStop is why LoginBounds stopped a login.
type LoginStop string

const (
	LoginTimedOut  LoginStop = "timed_out"
	LoginCancelled LoginStop = "cancelled"
)

// LoginBounds is the deadline and the caller's cancellation as one channel.
type LoginBounds struct {
	// Receives once, when the deadline passes or ctx ends, whichever comes first.
	Stopped <-chan LoginStop
	dispose func()
}

// Dispose stops watching; Stopped then never receives.
func (b LoginBounds) Dispose() { b.dispose() }

// NewLoginBounds watches ctx and a deadline timeout from now. A context
// already cancelled stops at once.
func NewLoginBounds(ctx context.Context, timeout time.Duration) LoginBounds {
	stopped := make(chan LoginStop, 1)
	disposed := make(chan struct{})
	timer := time.NewTimer(timeout)
	if ctx.Err() != nil {
		stopped <- LoginCancelled
	} else {
		go func() {
			select {
			case <-timer.C:
				stopped <- LoginTimedOut
			case <-ctx.Done():
				stopped <- LoginCancelled
			case <-disposed:
			}
		}()
	}
	var once sync.Once
	return LoginBounds{Stopped: stopped, dispose: func() {
		once.Do(func() {
			timer.Stop()
			close(disposed)
		})
	}}
}

// StoppedResult is the result for a bounds stop: a timeout is a failure, a cancellation is cancelled.
func StoppedResult(stop LoginStop, timeout time.Duration) oar.LoginResult {
	if stop == LoginCancelled {
		return oar.LoginResult{Kind: "cancelled"}
	}
	return oar.LoginResult{Kind: "failed", Reason: "timed_out", Detail: fmt.Sprintf("no sign-in within %d ms", timeout.Milliseconds())}
}

// ExecutableRefusal is what ends a login or a logout before anything runs:
// "unsupported" (Reason, Detail) or "failed" (Reason "process_failed", Detail).
type ExecutableRefusal struct {
	Kind   string
	Reason string
	Detail string
}

// LoginResult is the refusal as a login's answer.
func (r ExecutableRefusal) LoginResult() oar.LoginResult {
	return oar.LoginResult{Kind: r.Kind, Reason: r.Reason, Detail: r.Detail}
}

// LogoutResult is the refusal as a logout's answer.
func (r ExecutableRefusal) LogoutResult() oar.LogoutResult {
	return oar.LogoutResult{Kind: r.Kind, Reason: r.Reason, Detail: r.Detail}
}

// LoginExecutable is "executable" (Installation) or "settled" (Result: the
// login or logout ends before anything runs).
type LoginExecutable struct {
	Kind         string
	Installation oar.AvailableInstallation
	Result       ExecutableRefusal
}

// LoginExecutableOf is the executable to sign in (or out), or the result
// that ends the login before anything runs: a bundled runtime or a version
// known to predate floor ("" for none) is unsupported, and an executable
// that is no longer there (found as the installation probe finds it,
// without spawning) fails alike on every platform, since a missing command
// started through a Windows shell would only exit. An unreadable version is
// tried, not refused: the login command itself then answers.
func LoginExecutableOf(installation oar.AvailableInstallation, name, floor string) LoginExecutable {
	if installation.Via != "executable" {
		return LoginExecutable{Kind: "settled", Result: ExecutableRefusal{Kind: "unsupported", Reason: "unsupported_installation", Detail: "not a machine-installed executable"}}
	}
	version := ReleaseVersion(installation.Version)
	if floor != "" && version != "" && !VersionAtLeast(version, floor) {
		return LoginExecutable{Kind: "settled", Result: ExecutableRefusal{Kind: "unsupported", Reason: "version_unsupported", Detail: name + " " + floor + " or later is required; this is " + version}}
	}
	if LocateExecutable(installation.Command) == "" {
		return LoginExecutable{Kind: "settled", Result: ExecutableRefusal{Kind: "failed", Reason: "process_failed", Detail: name + " executable not found: " + installation.Command}}
	}
	return LoginExecutable{Kind: "executable", Installation: installation}
}
