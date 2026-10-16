package grok

import (
	"bytes"
	"encoding/json"
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
