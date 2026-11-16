//go:build thin_desktop

package main

import (
	"context"
	"errors"
	"io"
)

var errThinDesktopMigrateUnsupported = errors.New("vibe-desktop: migrate subcommands require embedded stack and are unavailable in thin_desktop builds")

func attachEmbeddedStackToApp(_ *DesktopApp) func() {
	return nil
}

func runDesktopMigrateUp(_ context.Context, _ string, _ io.Writer) error {
	return errThinDesktopMigrateUnsupported
}

func runDesktopMigrateDown(_ context.Context, _ string, _ int, _ bool, _ io.Writer) error {
	return errThinDesktopMigrateUnsupported
}

func runDesktopMigrateStatus(_ context.Context, _ string, _ io.Writer) error {
	return errThinDesktopMigrateUnsupported
}
