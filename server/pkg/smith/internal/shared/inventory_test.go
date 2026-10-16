package shared

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

func TestInventoryReadBoundsAndHidesFailures(t *testing.T) {
	ctx := context.Background()
	released := make(chan struct{})
	result, err := InventoryRead(ctx, 30*time.Millisecond, func(ctx context.Context) (oar.InventoryResult[oar.SkillEntry], error) {
		<-ctx.Done()
		close(released)
		return oar.InventoryResult[oar.SkillEntry]{}, ctx.Err()
	})
	if err != nil || result.Kind != "unavailable" || result.Code != "timeout" || result.Reason != "Native inventory query timed out" {
		t.Fatalf("result = %+v, %v", result, err)
	}
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("the timeout did not release the read")
	}
	failed, _ := InventoryRead(ctx, 0, func(context.Context) (oar.InventoryResult[oar.SkillEntry], error) {
		return oar.InventoryResult[oar.SkillEntry]{}, errors.New("Authorization: secret")
	})
	if failed.Kind != "unavailable" || failed.Code != "query_failed" || failed.Reason != "Native inventory query failed" {
		t.Fatalf("failed = %+v", failed)
	}
	scope := WorkspaceScope(oar.InventoryOptions{})
	ok, _ := InventoryRead(ctx, time.Second, func(context.Context) (oar.InventoryResult[oar.SkillEntry], error) {
		return InventoryOk[oar.SkillEntry](scope, "discovered", nil, false), nil
	})
	jsonEqual(t, ok, `{"kind":"ok","scope":`+jsonText(scope)+`,"observedAt":"`+ok.ObservedAt+`","view":"discovered","items":[],"partial":false}`)
	if _, err := InventoryRead(ctx, -time.Second, func(context.Context) (oar.InventoryResult[oar.SkillEntry], error) {
		return ok, nil
	}); err == nil {
		t.Fatal("a negative timeout is an error")
	}
}

func TestWorkspaceScopeResolvesCwd(t *testing.T) {
	cwd, _ := os.Getwd()
	if got := WorkspaceScope(oar.InventoryOptions{Cwd: "./project-b"}); got.Kind != "workspace" || got.Cwd != filepath.Join(cwd, "project-b") {
		t.Fatalf("got %+v", got)
	}
	if got := WorkspaceScope(oar.InventoryOptions{}); got.Cwd != cwd {
		t.Fatalf("got %+v", got)
	}
	if got := ListingCwd(oar.ListModelsOptions{Cwd: "x"}); got != filepath.Join(cwd, "x") {
		t.Fatalf("got %q", got)
	}
}

func TestNativeRows(t *testing.T) {
	if _, err := NativeRows("invalid"); err == nil || err.Error() != "Native inventory response has no list" {
		t.Fatalf("err = %v", err)
	}
	if _, err := NativeRows([]any{map[string]any{}, 3.0}); err == nil || err.Error() != "Native inventory entry is not an object" {
		t.Fatalf("err = %v", err)
	}
	rows, err := NativeRows([]any{map[string]any{"name": "a"}})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows = %v, %v", rows, err)
	}
	if name, err := Named(rows[0]); err != nil || name != "a" {
		t.Fatalf("name = %q, %v", name, err)
	}
	if _, err := Named(map[string]any{}); err == nil || err.Error() != "Native inventory entry has no name" {
		t.Fatalf("err = %v", err)
	}
	if TextField(3.0) != "" || TextField("x") != "x" || BoolField("true") != nil || *BoolField(false) {
		t.Fatal("fields")
	}
	jsonEqual(t, UnsupportedInventory[oar.ToolEntry]("transport_unavailable", "r"), `{"kind":"unsupported","code":"transport_unavailable","reason":"r"}`)
}
