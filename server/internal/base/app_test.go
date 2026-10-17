package base

import (
	"context"
	"errors"
	"go.uber.org/fx"
	"testing"
)

func TestAppWithoutDatabaseCanClose(t *testing.T) {
	a, err := NewApp(Config{Home: t.TempDir(), WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.Close()
}

func TestFailedStartCancelsItsLifetime(t *testing.T) {
	var lifetime context.Context
	a, err := NewApp(Config{Home: t.TempDir(), WorkRoot: t.TempDir()}, nil, fx.Invoke(func(lc fx.Lifecycle) {
		lc.Append(fx.Hook{OnStart: func(ctx context.Context) error { lifetime = ctx; return errors.New("cannot start") }})
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.Start(context.Background()); err == nil {
		t.Fatal("start succeeded")
	}
	if lifetime == nil || lifetime.Err() == nil {
		t.Fatal("failed start kept its lifetime alive")
	}
}
