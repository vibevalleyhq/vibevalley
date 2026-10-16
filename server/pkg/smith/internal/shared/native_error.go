package shared

import "vibevalley/pkg/smith/internal/jsonx"

// NativeError is diagnostic context for a failed native call, also usable
// before a Session exists to hold records.
type NativeError struct {
	Method string
	Native jsonx.Record
}

// NativeErrorCause redacts native (keys and string values, recursively)
// through redact. Only decoded protocol JSON, never an arbitrary error,
// request parameters or spawn arguments. native is not modified.
func NativeErrorCause(method string, native jsonx.Record, redact func(string) string) NativeError {
	return NativeError{Method: method, Native: redactNativeRecord(native, redact)}
}

func redactNative(value any, redact func(string) string) any {
	switch typed := value.(type) {
	case string:
		return redact(typed)
	case []any:
		out := make([]any, len(typed))
		for index, entry := range typed {
			out[index] = redactNative(entry, redact)
		}
		return out
	case map[string]any:
		return redactNativeRecord(typed, redact)
	}
	return value
}

func redactNativeRecord(record jsonx.Record, redact func(string) string) jsonx.Record {
	if record == nil {
		return nil
	}
	out := make(jsonx.Record, len(record))
	for key, value := range record {
		out[redact(key)] = redactNative(value, redact)
	}
	return out
}
