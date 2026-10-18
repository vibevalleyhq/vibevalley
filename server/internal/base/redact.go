package base

import (
	"io"
	"regexp"
)

// Secrets as they show up in free text: a token by its own shape, or the value after a name that says it is one. The server's
// log and whatever memory sends to a source outside the farm both go through Redact, so a rule added here covers both.
var secretShapes = []*regexp.Regexp{
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_\-]{16,}`),
	regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`),
	regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9\-]{10,}`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bAIza[0-9A-Za-z_\-]{30,}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`),
	// The farm's own session tokens (session/tokens.go).
	regexp.MustCompile(`\bhb_[A-Za-z0-9]+_[A-Za-z0-9_\-]{16,}`),
}

// The name and what joins it stay, so what was there can still be read: api_key=[redacted], "token": "[redacted]".
var (
	secretBearer = regexp.MustCompile(`(?i)(\bbearer\s+)[A-Za-z0-9._~+/=\-]{8,}`)
	secretNamed  = regexp.MustCompile(`(?i)(\b[a-z0-9_.\-]*(?:api[_\-]?key|secret|token|password|passwd|access[_\-]?key|certificate)[a-z0-9_]*["']?\s*[=:]\s*["']?)([^\s"',;]{6,})`)
)

const redacted = "[redacted]"

func Redact(text string) string {
	for _, shape := range secretShapes {
		text = shape.ReplaceAllString(text, redacted)
	}
	text = secretBearer.ReplaceAllString(text, "${1}"+redacted)
	return secretNamed.ReplaceAllStringFunc(text, func(m string) string {
		parts := secretNamed.FindStringSubmatch(m)
		if parts[2] == redacted {
			return m
		}
		return parts[1] + redacted
	})
}

// Each write is redacted whole: the log package writes one line at a time.
type redacting struct{ w io.Writer }

func (r redacting) Write(p []byte) (int, error) {
	if _, err := r.w.Write([]byte(Redact(string(p)))); err != nil {
		return 0, err
	}
	return len(p), nil
}

func RedactingWriter(w io.Writer) io.Writer { return redacting{w} }
