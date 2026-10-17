package main

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestTerminalOwnsInputAndInterrupts(t *testing.T) {
	r, w := io.Pipe()
	interrupts := make(chan os.Signal, 1)
	stopped := make(chan struct{})
	in := readTerminal(context.Background(), r, interrupts, func() { close(stopped) })
	defer w.Close()
	defer in.close()
	go io.WriteString(w, " hi \n")
	if e := <-in.events; e.text != "hi" || e.interrupt || e.err != nil {
		t.Fatalf("%+v", e)
	}
	interrupts <- os.Interrupt
	if e := <-in.events; !e.interrupt {
		t.Fatal("lost interrupt")
	}
	in.close()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("signal subscription retained")
	}
	select {
	case _, ok := <-in.events:
		if ok {
			t.Fatal("event after close")
		}
	case <-time.After(time.Second):
		t.Fatal("input not closed")
	}
	if _, err := w.Write([]byte("late")); err == nil {
		t.Fatal("stdin still owned after close")
	}
}
func TestTerminalReportsReadFailure(t *testing.T) {
	in := readTerminal(context.Background(), io.NopCloser(strings.NewReader(strings.Repeat("x", (1<<20)+1))), nil, func() {})
	defer in.close()
	if e := <-in.events; e.err == nil {
		t.Fatal("read failure hidden as EOF")
	}
}
