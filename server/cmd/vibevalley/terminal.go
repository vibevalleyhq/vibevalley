package main

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
)

type terminalEvent struct {
	text      string
	interrupt bool
	err       error
}

// The terminal owns stdin and signal subscriptions until Close; chat drivers only interpret user intents.
type terminal struct {
	events <-chan terminalEvent
	close  func()
}

func openTerminal(ctx context.Context, input io.ReadCloser) *terminal {
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	return readTerminal(ctx, input, interrupts, func() { signal.Stop(interrupts) })
}

func readTerminal(ctx context.Context, input io.ReadCloser, interrupts <-chan os.Signal, stopSignals func()) *terminal {
	ctx, cancel := context.WithCancel(ctx)
	out := make(chan terminalEvent)
	lines := make(chan terminalEvent)
	closeInput := sync.OnceFunc(func() { cancel(); stopSignals(); input.Close() })
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		for scanner.Scan() {
			select {
			case lines <- terminalEvent{text: strings.TrimSpace(scanner.Text())}:
			case <-ctx.Done():
				return
			}
		}
		if err := scanner.Err(); err != nil {
			select {
			case lines <- terminalEvent{err: err}:
			case <-ctx.Done():
			}
		}
	}()
	go func() {
		defer close(out)
		defer closeInput()
		for {
			var event terminalEvent
			select {
			case <-ctx.Done():
				return
			case line, ok := <-lines:
				if !ok {
					return
				}
				event = line
			case _, ok := <-interrupts:
				if !ok {
					interrupts = nil
					continue
				}
				event.interrupt = true
			}
			select {
			case out <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return &terminal{events: out, close: closeInput}
}
