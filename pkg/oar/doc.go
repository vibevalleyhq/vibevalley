// Package oar implements a zero-dependency Go runtime adapter layer for external
// coding-agent CLIs (Claude Code, Codex, ACP-based runtimes, Qwen Code, and Qoder).
//
// It strictly depends only on the Go standard library so offline replay suites
// and remote machine nodes run without external packages, Node.js, or database drivers.
package oar
