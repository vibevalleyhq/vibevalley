package base

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.uber.org/fx"
)

func leaseConfig(t *testing.T) Config {
	t.Helper()
	cfg := Defaults()
	cfg.Home, cfg.WorkRoot, cfg.DBPath = t.TempDir(), t.TempDir(), ":memory:"
	return cfg
}

func TestHomeLeaseRejectsAnotherAppBeforeConstructingServices(t *testing.T) {
	cfg := leaseConfig(t)
	first, err := NewApp(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	constructed := false
	second, err := NewApp(cfg, nil, fx.Invoke(func() { constructed = true }))
	if err == nil {
		second.Close()
		t.Fatal("two apps own one home")
	}
	if !strings.Contains(err.Error(), "正被另一个服务端使用") {
		t.Fatal(err)
	}
	if constructed {
		t.Fatal("second app constructed services before exclusion")
	}
	other := cfg
	other.Home = t.TempDir()
	independent, err := NewApp(other, nil)
	if err != nil {
		t.Fatal(err)
	}
	independent.Close()
}

func TestHomeLeaseLastsThroughStopWritesAndReleasesOnce(t *testing.T) {
	cfg := leaseConfig(t)
	file := filepath.Join(cfg.Home, "final-write")
	first, err := NewApp(cfg, nil, fx.Invoke(func(lc fx.Lifecycle) {
		lc.Append(fx.Hook{OnStop: func(context.Context) error {
			if other, err := NewApp(cfg, nil); err == nil {
				other.Close()
				return errors.New("lease released before OnStop finished")
			}
			return os.WriteFile(file, []byte("saved"), 0600)
		}})
	}))
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	first.Close()
	if body, err := os.ReadFile(file); err != nil || string(body) != "saved" {
		t.Fatalf("final write: %q %v", body, err)
	}
	next, err := NewApp(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	first.Close()
	if another, err := NewApp(cfg, nil); err == nil {
		another.Close()
		t.Fatal("closing old app released new owner's lease")
	}
}

func TestHomeLeaseReleasesOnConstructionFailure(t *testing.T) {
	cfg := leaseConfig(t)
	failed := errors.New("construction failed")
	if _, err := NewApp(cfg, nil, fx.Error(failed)); !errors.Is(err, failed) {
		t.Fatal(err)
	}
	next, err := NewApp(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	next.Close()
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	bad := cfg
	bad.WorkRoot = filepath.Join(file, "work")
	if _, err := NewApp(bad, nil); err == nil {
		t.Fatal("bad work root accepted")
	}
	next, err = NewApp(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	next.Close()
}

func TestHomeLeaseRejectsSymlinkAlias(t *testing.T) {
	cfg := leaseConfig(t)
	first, err := NewApp(cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	alias := filepath.Join(t.TempDir(), "same-home")
	if err := os.Symlink(cfg.Home, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	cfg.Home = alias
	if second, err := NewApp(cfg, nil); err == nil {
		second.Close()
		t.Fatal("symlink bypassed home lease")
	}
}
