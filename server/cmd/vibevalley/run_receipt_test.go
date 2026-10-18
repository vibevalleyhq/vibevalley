package main

import (
	"io"
	"os"
	"strings"
	"testing"

	"vibevalley/internal/agent/brain"
	"vibevalley/pkg/ai"
)

func TestShowSettledUsesRunReceipt(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = write
	defer func() { os.Stdout = original; read.Close(); write.Close() }()
	prompts := 0
	show(brain.AgentSettled{Run: brain.RunResult{Usage: ai.Usage{Input: 17, CacheRead: 5, Output: 3}, Aborted: true, Settled: true}}, func() { prompts++ })
	write.Close()
	text, err := io.ReadAll(read)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(text), "停下了，输入 17，缓存 5，输出 3") || prompts != 1 {
		t.Fatalf("display %q prompts %d", text, prompts)
	}
}
