package base

// A variable already set in the environment wins over the file, as with Node; nothing read here is ever logged.

import (
	"errors"
	"io/fs"
	"os"
	"strconv"
	"strings"
)

// A missing file is not an error.
func LoadEnvFile(path string) error {
	body, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, kv := range ParseEnv(string(body)) {
		if _, set := os.LookupEnv(kv[0]); !set {
			if err := os.Setenv(kv[0], kv[1]); err != nil {
				return err
			}
		}
	}
	return nil
}

// As Node's util.parseEnv: blank lines and # comments skipped, an `export ` prefix dropped, values in single, double or back quotes taken as they are
// (double quotes turn \n into a newline, and may span lines), an unquoted value cut at its first # and trimmed. Later lines win.
func ParseEnv(text string) [][2]string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var out [][2]string
	index := map[string]int{}
	for len(text) > 0 {
		var line string
		line, text, _ = strings.Cut(text, "\n")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		trimmed = strings.TrimPrefix(trimmed, "export ")
		key, rest, ok := strings.Cut(trimmed, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			continue
		}
		rest = strings.TrimLeft(rest, " \t")
		var value string
		if q := firstQuote(rest); q != 0 {
			body := rest[1:]
			end := strings.IndexByte(body, q)
			// A quoted value may go on over the next lines until its closing quote.
			for end < 0 && len(text) > 0 {
				var next string
				next, text, _ = strings.Cut(text, "\n")
				body += "\n" + next
				end = strings.IndexByte(body, q)
			}
			if end < 0 {
				// No closing quote: the line as it is, as Node takes it.
				value = strings.TrimSpace(rest)
			} else {
				value = body[:end]
				if q == '"' {
					value = strings.ReplaceAll(value, `\n`, "\n")
				}
			}
		} else {
			if i := strings.IndexByte(rest, '#'); i >= 0 {
				rest = rest[:i]
			}
			value = strings.TrimSpace(rest)
		}
		if i, seen := index[key]; seen {
			out[i][1] = value
			continue
		}
		index[key] = len(out)
		out = append(out, [2]string{key, value})
	}
	return out
}

func firstQuote(s string) byte {
	if s == "" {
		return 0
	}
	switch s[0] {
	case '"', '\'', '`':
		return s[0]
	}
	return 0
}

func EnvNumber(name string, fallback float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(name), 64); err == nil {
		return v
	}
	return fallback
}
