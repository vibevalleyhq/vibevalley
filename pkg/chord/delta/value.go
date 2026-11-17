package delta

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"
)

var (
	ErrInvalidValue    = errors.New("delta: unsupported JSON value type")
	ErrNonFiniteNumber = errors.New("delta: non-finite float64 (NaN or Inf)")
	ErrInvalidJSON     = errors.New("delta: invalid JSON payload")
	ErrInvalidPath     = errors.New("delta: invalid path")
	ErrInvalidOp       = errors.New("delta: invalid operation")
	ErrNotContainer    = errors.New("delta: target path parent is not a container")
	ErrOutOfBounds     = errors.New("delta: array index out of bounds")
	ErrTypeMismatch    = errors.New("delta: target value type mismatch")
	ErrIntegrity       = errors.New("delta: snapshot hash verification failed")
)

// ValidateValue checks that v conforms strictly to the Chord JSON value subset:
// nil, bool, string, finite int64/float64, []any, or map[string]any.
func ValidateValue(v any) error {
	switch val := v.(type) {
	case nil, bool, string, int64:
		return nil
	case float64:
		if math.IsNaN(val) || math.IsInf(val, 0) {
			return fmt.Errorf("%w: %v", ErrNonFiniteNumber, val)
		}
		return nil
	case []any:
		for i, elem := range val {
			if err := ValidateValue(elem); err != nil {
				return fmt.Errorf("index %d: %w", i, err)
			}
		}
		return nil
	case map[string]any:
		for k, elem := range val {
			if err := ValidateValue(elem); err != nil {
				return fmt.Errorf("key %q: %w", k, err)
			}
		}
		return nil
	default:
		return fmt.Errorf("%w: %T", ErrInvalidValue, v)
	}
}

// CloneValue validates and deep-copies a strict JSON value.
// Typed nil slices and maps are normalized to empty non-nil containers so JSON
// round-trips preserve container type rather than collapsing into null.
func CloneValue(v any) (any, error) {
	switch val := v.(type) {
	case nil, bool, string, int64:
		return val, nil
	case float64:
		if math.IsNaN(val) || math.IsInf(val, 0) {
			return nil, fmt.Errorf("%w: %v", ErrNonFiniteNumber, val)
		}
		return val, nil
	case []any:
		out := make([]any, len(val))
		for i, elem := range val {
			cloned, err := CloneValue(elem)
			if err != nil {
				return nil, fmt.Errorf("index %d: %w", i, err)
			}
			out[i] = cloned
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, elem := range val {
			cloned, err := CloneValue(elem)
			if err != nil {
				return nil, fmt.Errorf("key %q: %w", k, err)
			}
			out[k] = cloned
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%w: %T", ErrInvalidValue, v)
	}
}

func cloneTrustedValue(v any) any {
	switch val := v.(type) {
	case nil, bool, string, int64, float64:
		return val
	case []any:
		out := make([]any, len(val))
		for i, elem := range val {
			out[i] = cloneTrustedValue(elem)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, elem := range val {
			out[k] = cloneTrustedValue(elem)
		}
		return out
	default:
		return val
	}
}

// MarshalValue validates strict JSON rules and encodes v to JSON bytes.
func MarshalValue(v any) ([]byte, error) {
	normalized, err := CloneValue(v)
	if err != nil {
		return nil, err
	}
	return json.Marshal(normalized)
}

// UnmarshalValue decodes JSON bytes into strict JSON values, preserving exact
// int64 integers when possible and falling back to finite float64 otherwise.
func UnmarshalValue(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidJSON, err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("%w: trailing tokens", ErrInvalidJSON)
	}
	return normalizeDecoded(raw)
}

func normalizeDecoded(v any) (any, error) {
	switch val := v.(type) {
	case nil, bool, string, int64:
		return val, nil
	case float64:
		if math.IsNaN(val) || math.IsInf(val, 0) {
			return nil, fmt.Errorf("%w: %v", ErrNonFiniteNumber, val)
		}
		return val, nil
	case json.Number:
		return parseJSONNumber(val.String())
	case []any:
		out := make([]any, len(val))
		for i, elem := range val {
			norm, err := normalizeDecoded(elem)
			if err != nil {
				return nil, err
			}
			out[i] = norm
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, elem := range val {
			norm, err := normalizeDecoded(elem)
			if err != nil {
				return nil, err
			}
			out[k] = norm
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%w: %T", ErrInvalidValue, v)
	}
}

func parseJSONNumber(raw string) (any, error) {
	if !strings.ContainsAny(raw, ".eE") {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return n, nil
		}
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNonFiniteNumber, err)
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil, fmt.Errorf("%w: %v", ErrNonFiniteNumber, raw)
	}
	return f, nil
}

// Equal reports deep equality between two strict JSON values.
// Integer int64 and integral float64 values representing the same exact number
// are treated as equal to preserve equivalence across JSON round-trips.
func Equal(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	switch va := a.(type) {
	case bool:
		vb, ok := b.(bool)
		return ok && va == vb
	case string:
		vb, ok := b.(string)
		return ok && va == vb
	case int64:
		switch vb := b.(type) {
		case int64:
			return va == vb
		case float64:
			return equalIntAndFloat(va, vb)
		default:
			return false
		}
	case float64:
		switch vb := b.(type) {
		case float64:
			if math.IsNaN(va) || math.IsNaN(vb) {
				return false
			}
			return va == vb
		case int64:
			return equalIntAndFloat(vb, va)
		default:
			return false
		}
	case []any:
		vb, ok := b.([]any)
		if !ok || len(va) != len(vb) {
			return false
		}
		for i := range va {
			if !Equal(va[i], vb[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		vb, ok := b.(map[string]any)
		if !ok || len(va) != len(vb) {
			return false
		}
		for k, elemA := range va {
			elemB, exists := vb[k]
			if !exists || !Equal(elemA, elemB) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func equalIntAndFloat(i int64, f float64) bool {
	if math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f {
		return false
	}
	const maxExactInt = 1 << 53
	if i >= -maxExactInt && i <= maxExactInt {
		return float64(i) == f
	}
	return strconv.FormatInt(i, 10) == strconv.FormatFloat(f, 'f', 0, 64)
}

// HashValue computes a canonical SHA-256 digest of a strict JSON value.
func HashValue(v any) ([32]byte, error) {
	if err := ValidateValue(v); err != nil {
		return [32]byte{}, err
	}
	h := sha256.New()
	hashInto(h, v)
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum, nil
}

func hashInto(w io.Writer, v any) {
	var buf [8]byte
	switch val := v.(type) {
	case nil:
		_, _ = w.Write([]byte{'N'})
	case bool:
		if val {
			_, _ = w.Write([]byte{'T'})
		} else {
			_, _ = w.Write([]byte{'F'})
		}
	case string:
		_, _ = w.Write([]byte{'S'})
		binary.LittleEndian.PutUint64(buf[:], uint64(len(val)))
		_, _ = w.Write(buf[:])
		_, _ = io.WriteString(w, val)
	case int64:
		_, _ = w.Write([]byte{'I'})
		binary.LittleEndian.PutUint64(buf[:], uint64(val))
		_, _ = w.Write(buf[:])
	case float64:
		_, _ = w.Write([]byte{'D'})
		if val == 0 {
			val = 0 // Collapse -0.0 and +0.0 into one bit pattern.
		}
		binary.LittleEndian.PutUint64(buf[:], math.Float64bits(val))
		_, _ = w.Write(buf[:])
	case []any:
		_, _ = w.Write([]byte{'A'})
		binary.LittleEndian.PutUint64(buf[:], uint64(len(val)))
		_, _ = w.Write(buf[:])
		for _, elem := range val {
			hashInto(w, elem)
		}
	case map[string]any:
		_, _ = w.Write([]byte{'M'})
		binary.LittleEndian.PutUint64(buf[:], uint64(len(val)))
		_, _ = w.Write(buf[:])
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			binary.LittleEndian.PutUint64(buf[:], uint64(len(k)))
			_, _ = w.Write(buf[:])
			_, _ = io.WriteString(w, k)
			hashInto(w, val[k])
		}
	}
}
