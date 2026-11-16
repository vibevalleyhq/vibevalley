//go:build thin_desktop

package main

func attachEmbeddedStackToApp(_ *DesktopApp) func() {
	return nil
}
