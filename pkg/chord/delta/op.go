package delta

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
)

// OpKind identifies a compact Chord delta tuple operation.
type OpKind string

const (
	OpReplace     OpKind = "r"
	OpDelete      OpKind = "d"
	OpAppendText  OpKind = "a"
	OpSpliceArray OpKind = "s"
)

// Op represents a single Chord mutation tuple in wire or in-memory form.
type Op struct {
	Kind        OpKind
	Path        []string
	Value       any
	Suffix      string
	Index       int
	DeleteCount int
	Items       []any
}

func ReplaceRoot(value any) Op {
	return Op{Kind: OpReplace, Value: value}
}

func Replace(path []string, value any) Op {
	return Op{Kind: OpReplace, Path: slices.Clone(path), Value: value}
}

func Delete(path []string) Op {
	return Op{Kind: OpDelete, Path: slices.Clone(path)}
}

func AppendText(path []string, suffix string) Op {
	return Op{Kind: OpAppendText, Path: slices.Clone(path), Suffix: suffix}
}

func SpliceArray(path []string, index, deleteCount int, items ...any) Op {
	return Op{
		Kind:        OpSpliceArray,
		Path:        slices.Clone(path),
		Index:       index,
		DeleteCount: deleteCount,
		Items:       slices.Clone(items),
	}
}

// Validate checks structural and strict-JSON invariants of op.
func (op Op) Validate() error {
	switch op.Kind {
	case OpReplace:
		return ValidateValue(op.Value)
	case OpDelete:
		if len(op.Path) == 0 {
			return fmt.Errorf("%w: delete requires non-empty path", ErrInvalidPath)
		}
		return nil
	case OpAppendText:
		return nil
	case OpSpliceArray:
		if op.Index < 0 {
			return fmt.Errorf("%w: negative splice index %d", ErrOutOfBounds, op.Index)
		}
		if op.DeleteCount < 0 {
			return fmt.Errorf("%w: negative deleteCount %d", ErrOutOfBounds, op.DeleteCount)
		}
		for i, item := range op.Items {
			if err := ValidateValue(item); err != nil {
				return fmt.Errorf("splice item %d: %w", i, err)
			}
		}
		return nil
	default:
		return fmt.Errorf("%w: unknown kind %q", ErrInvalidOp, op.Kind)
	}
}

// Clone validates and deep-copies op so callers share no mutable state.
func (op Op) Clone() (Op, error) {
	out := Op{
		Kind:        op.Kind,
		Path:        slices.Clone(op.Path),
		Suffix:      op.Suffix,
		Index:       op.Index,
		DeleteCount: op.DeleteCount,
	}
	switch op.Kind {
	case OpReplace:
		val, err := CloneValue(op.Value)
		if err != nil {
			return Op{}, err
		}
		out.Value = val
	case OpDelete:
		if len(op.Path) == 0 {
			return Op{}, fmt.Errorf("%w: delete requires non-empty path", ErrInvalidPath)
		}
	case OpAppendText:
	case OpSpliceArray:
		if op.Index < 0 {
			return Op{}, fmt.Errorf("%w: negative splice index %d", ErrOutOfBounds, op.Index)
		}
		if op.DeleteCount < 0 {
			return Op{}, fmt.Errorf("%w: negative deleteCount %d", ErrOutOfBounds, op.DeleteCount)
		}
		if len(op.Items) > 0 {
			out.Items = make([]any, len(op.Items))
			for i, item := range op.Items {
				cloned, err := CloneValue(item)
				if err != nil {
					return Op{}, fmt.Errorf("splice item %d: %w", i, err)
				}
				out.Items[i] = cloned
			}
		}
	default:
		return Op{}, fmt.Errorf("%w: unknown kind %q", ErrInvalidOp, op.Kind)
	}
	return out, nil
}

func (op Op) cloneTrusted() Op {
	out := Op{
		Kind:        op.Kind,
		Path:        slices.Clone(op.Path),
		Suffix:      op.Suffix,
		Index:       op.Index,
		DeleteCount: op.DeleteCount,
	}
	if op.Kind == OpReplace {
		out.Value = cloneTrustedValue(op.Value)
	} else if op.Kind == OpSpliceArray && len(op.Items) > 0 {
		out.Items = make([]any, len(op.Items))
		for i, item := range op.Items {
			out.Items[i] = cloneTrustedValue(item)
		}
	}
	return out
}

// MarshalJSON encodes op using Chord's compact JSON tuple format.
func (op Op) MarshalJSON() ([]byte, error) {
	cloned, err := op.Clone()
	if err != nil {
		return nil, err
	}
	var tuple []any
	switch cloned.Kind {
	case OpReplace:
		if len(cloned.Path) == 0 {
			tuple = []any{string(OpReplace), cloned.Value}
		} else {
			tuple = []any{string(OpReplace), nonNilPath(cloned.Path), cloned.Value}
		}
	case OpDelete:
		tuple = []any{string(OpDelete), nonNilPath(cloned.Path)}
	case OpAppendText:
		tuple = []any{string(OpAppendText), nonNilPath(cloned.Path), cloned.Suffix}
	case OpSpliceArray:
		tuple = make([]any, 4+len(cloned.Items))
		tuple[0] = string(OpSpliceArray)
		tuple[1] = nonNilPath(cloned.Path)
		tuple[2] = cloned.Index
		tuple[3] = cloned.DeleteCount
		copy(tuple[4:], cloned.Items)
	default:
		return nil, fmt.Errorf("%w: unknown kind %q", ErrInvalidOp, cloned.Kind)
	}
	return json.Marshal(tuple)
}

func nonNilPath(path []string) []string {
	if path == nil {
		return []string{}
	}
	return path
}

// UnmarshalJSON decodes Chord's compact JSON tuple format into an Op.
func (op *Op) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var tuple []json.RawMessage
	if err := dec.Decode(&tuple); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidOp, err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return fmt.Errorf("%w: trailing tokens", ErrInvalidOp)
	}
	if len(tuple) < 2 {
		return fmt.Errorf("%w: tuple too short", ErrInvalidOp)
	}
	var code string
	if err := json.Unmarshal(tuple[0], &code); err != nil {
		return fmt.Errorf("%w: opcode: %v", ErrInvalidOp, err)
	}
	switch OpKind(code) {
	case OpReplace:
		switch len(tuple) {
		case 2:
			val, err := UnmarshalValue(tuple[1])
			if err != nil {
				return err
			}
			*op = Op{Kind: OpReplace, Value: val}
			return nil
		case 3:
			path, err := decodePath(tuple[1])
			if err != nil {
				return err
			}
			val, err := UnmarshalValue(tuple[2])
			if err != nil {
				return err
			}
			*op = Op{Kind: OpReplace, Path: path, Value: val}
			return nil
		default:
			return fmt.Errorf("%w: invalid replace tuple length %d", ErrInvalidOp, len(tuple))
		}
	case OpDelete:
		if len(tuple) != 2 {
			return fmt.Errorf("%w: invalid delete tuple length %d", ErrInvalidOp, len(tuple))
		}
		path, err := decodePath(tuple[1])
		if err != nil {
			return err
		}
		if len(path) == 0 {
			return fmt.Errorf("%w: delete requires non-empty path", ErrInvalidPath)
		}
		*op = Op{Kind: OpDelete, Path: path}
		return nil
	case OpAppendText:
		if len(tuple) != 3 {
			return fmt.Errorf("%w: invalid append tuple length %d", ErrInvalidOp, len(tuple))
		}
		path, err := decodePath(tuple[1])
		if err != nil {
			return err
		}
		var suffix string
		if err := json.Unmarshal(tuple[2], &suffix); err != nil {
			return fmt.Errorf("%w: append suffix: %v", ErrInvalidOp, err)
		}
		*op = Op{Kind: OpAppendText, Path: path, Suffix: suffix}
		return nil
	case OpSpliceArray:
		if len(tuple) < 4 {
			return fmt.Errorf("%w: invalid splice tuple length %d", ErrInvalidOp, len(tuple))
		}
		path, err := decodePath(tuple[1])
		if err != nil {
			return err
		}
		index, err := decodeNonNegInt(tuple[2])
		if err != nil {
			return fmt.Errorf("%w: splice index: %v", ErrInvalidOp, err)
		}
		deleteCount, err := decodeNonNegInt(tuple[3])
		if err != nil {
			return fmt.Errorf("%w: splice deleteCount: %v", ErrInvalidOp, err)
		}
		var items []any
		if len(tuple) > 4 {
			items = make([]any, len(tuple)-4)
			for i, raw := range tuple[4:] {
				val, err := UnmarshalValue(raw)
				if err != nil {
					return fmt.Errorf("splice item %d: %w", i, err)
				}
				items[i] = val
			}
		}
		*op = Op{
			Kind:        OpSpliceArray,
			Path:        path,
			Index:       index,
			DeleteCount: deleteCount,
			Items:       items,
		}
		return nil
	default:
		return fmt.Errorf("%w: unknown opcode %q", ErrInvalidOp, code)
	}
}

func decodePath(raw json.RawMessage) ([]string, error) {
	var path []string
	if err := json.Unmarshal(raw, &path); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidPath, err)
	}
	if path == nil {
		return nil, fmt.Errorf("%w: null path", ErrInvalidPath)
	}
	if len(path) == 0 {
		return nil, nil
	}
	return path, nil
}

func decodeNonNegInt(raw json.RawMessage) (int, error) {
	val, err := UnmarshalValue(raw)
	if err != nil {
		return 0, err
	}
	n, ok := val.(int64)
	if !ok || n < 0 {
		return 0, fmt.Errorf("expected non-negative integer, got %v", val)
	}
	return int(n), nil
}

func hasPathPrefix(path, prefix []string) bool {
	return len(path) >= len(prefix) && slices.Equal(path[:len(prefix)], prefix)
}

func hasStrictPathPrefix(path, prefix []string) bool {
	return len(path) > len(prefix) && slices.Equal(path[:len(prefix)], prefix)
}

func pathsOverlap(a, b []string) bool {
	return hasPathPrefix(a, b) || hasPathPrefix(b, a)
}

// parseArrayIndex parses canonical non-negative decimal array indices ("0", "1", "12").
func parseArrayIndex(seg string) (int, bool) {
	if seg == "" {
		return 0, false
	}
	if len(seg) > 1 && seg[0] == '0' {
		return 0, false
	}
	for i := 0; i < len(seg); i++ {
		if seg[i] < '0' || seg[i] > '9' {
			return 0, false
		}
	}
	idx, err := strconv.Atoi(seg)
	if err != nil || idx < 0 {
		return 0, false
	}
	return idx, true
}
