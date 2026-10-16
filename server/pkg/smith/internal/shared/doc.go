// Package shared is the Go port of the runtime-independent helpers in
// packages/oar/src/shared (top level): installation probes, install and
// update plans, login and logout mechanics, failure classes, inventory
// helpers, session option checks, private temporary directories and the
// abort fallback. One Go file per TS file.
package shared

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode"
)

// jsonText is JSON.stringify of a value: no HTML escaping, no trailing newline.
func jsonText(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return ""
	}
	return string(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
}

// jsTrim is String.prototype.trim: Unicode white space and the BOM.
func jsTrim(text string) string {
	return strings.TrimFunc(text, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' })
}
