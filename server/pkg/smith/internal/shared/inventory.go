package shared

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// DefaultInventoryTimeout bounds an inventory read when the caller gives none.
const DefaultInventoryTimeout = 15 * time.Second

// NativeInventoryRequest is one native request of an inventory reader.
type NativeInventoryRequest func(ctx context.Context, method string, params jsonx.Record) (jsonx.Record, error)

// WorkspaceScope is the workspace at options.Cwd resolved against the host's cwd (its default).
func WorkspaceScope(options oar.InventoryOptions) oar.InventoryScope {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	target := options.Cwd
	if target == "" {
		target = "."
	}
	return oar.InventoryScope{Kind: "workspace", Cwd: resolvePath(cwd, target)}
}

// InventoryOk is an "ok" result observed now.
func InventoryOk[T any](scope oar.InventoryScope, view string, items []T, partial bool) oar.InventoryResult[T] {
	if items == nil {
		items = []T{}
	}
	return oar.InventoryResult[T]{Kind: "ok", Scope: scope, ObservedAt: oar.UtcInstantFromTime(time.Now()), View: view, Items: items, Partial: partial}
}

// UnsupportedInventory is an "unsupported" result.
func UnsupportedInventory[T any](code, reason string) oar.InventoryResult[T] {
	return oar.InventoryResult[T]{Kind: "unsupported", Code: code, Reason: reason}
}

// UnavailableInventory is an "unavailable" result.
func UnavailableInventory[T any](code, reason string) oar.InventoryResult[T] {
	return oar.InventoryResult[T]{Kind: "unavailable", Code: code, Reason: reason}
}

// NativeRows reads a native list whose entries are all objects.
func NativeRows(value any) ([]jsonx.Record, error) {
	list, ok := value.([]any)
	if !ok {
		return nil, errors.New("Native inventory response has no list")
	}
	rows := make([]jsonx.Record, 0, len(list))
	for _, item := range list {
		row := jsonx.AsRecord(item)
		if row == nil {
			return nil, errors.New("Native inventory entry is not an object")
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// Named is a native entry's name.
func Named(row jsonx.Record) (string, error) {
	name, ok := row["name"].(string)
	if !ok {
		return "", errors.New("Native inventory entry has no name")
	}
	return name, nil
}

// TextField is value when it is a string, else "" (TS: the field left out).
func TextField(value any) string {
	text, _ := value.(string)
	return text
}

// BoolField is value when it is a boolean, else nil (TS: the field left out).
func BoolField(value any) *bool {
	flag, ok := value.(bool)
	if !ok {
		return nil
	}
	return &flag
}

// InventoryRead bounds a read with a deadline (0: DefaultInventoryTimeout;
// negative is an error). At the deadline the read's ctx is cancelled and the
// answer is unavailable/timeout without waiting for the read; subprocess
// readers dispose their owned process when their ctx ends. A failed read is
// unavailable/query_failed and never carries the native error, which can
// contain command arguments, headers or credentials.
func InventoryRead[T any](ctx context.Context, timeout time.Duration, read func(ctx context.Context) (oar.InventoryResult[T], error)) (oar.InventoryResult[T], error) {
	if timeout < 0 {
		return oar.InventoryResult[T]{}, fmt.Errorf("timeout must be positive, got %s", timeout)
	}
	if timeout == 0 {
		timeout = DefaultInventoryTimeout
	}
	readCtx, cancel := context.WithCancel(ctx)
	type outcome struct {
		result oar.InventoryResult[T]
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- outcome{err: fmt.Errorf("inventory read panicked: %v", recovered)}
			}
		}()
		result, err := read(readCtx)
		done <- outcome{result, err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case settled := <-done:
		cancel()
		if settled.err != nil {
			return UnavailableInventory[T]("query_failed", "Native inventory query failed"), nil
		}
		return settled.result, nil
	case <-timer.C:
		cancel()
		return UnavailableInventory[T]("timeout", "Native inventory query timed out"), nil
	}
}
