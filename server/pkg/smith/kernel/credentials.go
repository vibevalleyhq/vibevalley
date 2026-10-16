package kernel

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Session credential redaction (shared/credential-redactor.ts,
// session-credentials.ts): values the session was given as credentials are
// replaced by "[redacted]" in every record before retention and observer
// delivery, and in every error a session returns. Native inputs to the
// runtime stay unchanged.

var credentialWords = map[string]bool{"KEY": true, "APIKEY": true, "TOKEN": true, "SECRET": true, "PASSWORD": true, "PASSWD": true, "PASSPHRASE": true, "CREDENTIAL": true, "CREDENTIALS": true, "COOKIE": true, "PWD": true}
var authHeaders = map[string]bool{"AUTHORIZATION": true, "PROXY-AUTHORIZATION": true}
var credentialNames = map[string]bool{"PGPASSWORD": true}

const credentialMinLength = 8

var pathValue = regexp.MustCompile(`(?i)^(?:/|~/|[a-z]:\\)`)
var schemePattern = regexp.MustCompile(`(?i)^[a-z][a-z\d+.-]*://`)
var authorizationValue = regexp.MustCompile(`^\s*\S+\s+(.+?)\s*$`)

func credentialValue(value string) bool {
	return len([]rune(value)) >= credentialMinLength && !pathValue.MatchString(value)
}

func urlCredentials(value string) []string {
	if !schemePattern.MatchString(value) {
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.User == nil {
		return nil
	}
	password, ok := parsed.User.Password()
	if !ok || password == "" {
		return nil
	}
	// The encoded form, as it appears in the URL text.
	encoded := password
	if start := strings.Index(value, "://"); start >= 0 {
		rest := value[start+3:]
		if at := strings.LastIndex(rest[:strings.IndexAny(rest+"/", "/?#")], "@"); at >= 0 {
			userinfo := rest[:at]
			if colon := strings.Index(userinfo, ":"); colon >= 0 {
				encoded = userinfo[colon+1:]
			}
		}
	}
	out := []string{value}
	for _, candidate := range []string{encoded, password} {
		if len([]rune(candidate)) >= credentialMinLength {
			out = append(out, candidate)
		}
	}
	return out
}

// Redactor replaces known session credentials.
type Redactor struct {
	mu     sync.Mutex
	known  map[string]bool
	values []string
}

// NewRedactor collects the explicit session credentials in options.
func NewRedactor(options oar.SessionOptions) *Redactor {
	r := &Redactor{known: map[string]bool{}}
	env := func(entries map[string]*string) {
		for name, value := range entries {
			if value == nil {
				continue
			}
			upper := strings.ToUpper(name)
			parts := strings.Split(upper, "_")
			if credentialWords[parts[len(parts)-1]] || credentialNames[upper] {
				r.addLocked(*value)
			}
			for _, credential := range urlCredentials(*value) {
				r.known[credential] = true
			}
		}
	}
	env(options.Env)
	for _, server := range options.MCPServers {
		if !server.IsHTTP() {
			converted := map[string]*string{}
			for name, value := range server.Env {
				converted[name] = oar.String(value)
			}
			env(converted)
			continue
		}
		for name, value := range server.Headers {
			upper := strings.ToUpper(name)
			parts := strings.Split(upper, "-")
			authorization := authHeaders[upper]
			if authorization || credentialWords[parts[len(parts)-1]] {
				r.addLocked(value)
			}
			if authorization {
				if match := authorizationValue.FindStringSubmatch(value); match != nil {
					r.addLocked(match[1])
				}
			}
		}
	}
	r.sortLocked()
	return r
}

func (r *Redactor) addLocked(value string) {
	if credentialValue(value) {
		r.known[value] = true
	}
}

func (r *Redactor) sortLocked() {
	values := make([]string, 0, len(r.known))
	for value := range r.known {
		values = append(values, value)
	}
	sort.SliceStable(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	r.values = values
}

// Add learns a runtime-native key resolved after open.
func (r *Redactor) Add(value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if credentialValue(value) && !r.known[value] {
		r.known[value] = true
		r.sortLocked()
	}
}

func (r *Redactor) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.values
}

// Text replaces every known value in text.
func (r *Redactor) Text(text string) string {
	for _, value := range r.snapshot() {
		text = strings.ReplaceAll(text, value, "[redacted]")
	}
	return text
}

func (r *Redactor) contains(text string) bool {
	for _, value := range r.snapshot() {
		if strings.Contains(text, value) {
			return true
		}
	}
	return false
}

// JSON rewrites every string of a JSON text; the input when nothing matched.
func (r *Redactor) JSON(raw json.RawMessage) json.RawMessage {
	if len(r.snapshot()) == 0 || len(raw) == 0 {
		return raw
	}
	out, changed, err := jsonx.MapStrings(raw, r.Text)
	if err != nil || !changed {
		return raw
	}
	return out
}

// Record redacts one record; the record itself when nothing matched.
func (r *Redactor) Record(record oar.RawEvent) oar.RawEvent {
	values := r.snapshot()
	if len(values) == 0 {
		return record
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return record
	}
	out, changed, err := jsonx.MapStrings(encoded, r.Text)
	if err != nil || !changed {
		return record
	}
	var redacted oar.RawEvent
	if err := json.Unmarshal(out, &redacted); err != nil {
		return record
	}
	return redacted
}

// Error redacts an error's text, keeping the typed open errors typed.
func (r *Redactor) Error(err error) error {
	if err == nil || len(r.snapshot()) == 0 {
		return err
	}
	var unsupported *oar.UnsupportedOptionError
	var notFound *oar.SessionNotFoundError
	var unavailable *oar.SessionUnavailableError
	var failure *oar.RuntimeFailureError
	switch {
	case errors.As(err, &unsupported):
		if !r.contains(unsupported.Message) {
			return err
		}
		return &oar.UnsupportedOptionError{Option: unsupported.Option, Message: r.Text(unsupported.Message)}
	case errors.As(err, &notFound):
		copied := *notFound
		copied.SessionID = r.Text(copied.SessionID)
		copied.Message = r.Text(copied.Message)
		copied.Native = r.JSON(copied.Native)
		return &copied
	case errors.As(err, &unavailable):
		copied := *unavailable
		copied.SessionID = r.Text(copied.SessionID)
		copied.Message = r.Text(copied.Message)
		copied.Native = r.JSON(copied.Native)
		return &copied
	case errors.As(err, &failure):
		copied := *failure
		copied.Reason = r.Text(copied.Reason)
		copied.Cause = r.Error(copied.Cause)
		return &copied
	}
	if !r.contains(err.Error()) {
		return err
	}
	return errors.New(r.Text(err.Error()))
}

// Credentials is the per-session redaction plumbing an adapter opens with.
type Credentials struct {
	*Redactor
}

// Kernel starts the session's stream with the redactor applied.
func (c Credentials) Kernel(sessionID string, options ...Option) *Kernel {
	return New(sessionID, append([]Option{WithRedactor(c.Record)}, options...)...)
}

// Seal derives the API face, redacting adapter errors.
func (c Credentials) Seal(adapter oar.AdapterSession) oar.Session {
	return SealRedacting(adapter, c.Error)
}

// Open is an adapter's opening function with its credentials.
type Open func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions, credentials Credentials) (oar.Session, error)

// WithSessionCredentials keeps opening failures and later adapter errors
// under the same credential rules as the record stream.
func WithSessionCredentials(open Open) oar.StartSession {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		credentials := Credentials{NewRedactor(options)}
		session, err := open(ctx, installation, options, credentials)
		if err != nil {
			return nil, credentials.Error(err)
		}
		return session, nil
	}
}
