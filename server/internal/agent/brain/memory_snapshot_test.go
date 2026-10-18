package brain

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMemoryWriteReturnsItsOwnReceipt(t *testing.T) {
	dir := t.TempDir()
	const count = 12
	receipts := make(chan MemoryLine, count)
	failures := make(chan error, count)
	var wg sync.WaitGroup
	for i := range count {
		wg.Go(func() {
			note := fmt.Sprintf("note-%d", i)
			written, err := Remember(dir, note, time.Date(2026, 10, 18, 12, 0, 0, 0, time.Local))
			if err != nil {
				failures <- err
				return
			}
			if written.Text != note || written.Date != "2026-10-18" || written.ID == "" {
				failures <- fmt.Errorf("receipt for %s: %+v", note, written)
				return
			}
			receipts <- written
		})
	}
	wg.Wait()
	close(receipts)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	snapshot := ReadMemory(dir)
	if len(snapshot.Lines) != count {
		t.Fatalf("lines %d", len(snapshot.Lines))
	}
	stored := map[string]string{}
	for _, line := range snapshot.Lines {
		stored[line.ID] = line.Text
	}
	for receipt := range receipts {
		if stored[receipt.ID] != receipt.Text {
			t.Fatalf("receipt differs from stored note: %+v", receipt)
		}
	}
	rewritten, err := RewriteMemory(dir, "# heading\n- one\n- two\n")
	if err != nil {
		t.Fatal(err)
	}
	if rewritten.LineCount != 3 || len(rewritten.Lines) != 2 {
		t.Fatalf("rewrite receipt: %+v", rewritten)
	}
}

func TestMemoryPromptAndCarriedLinesUseTheSameRawText(t *testing.T) {
	dir := t.TempDir()
	text := "- old\n" + strings.Repeat("# "+strings.Repeat("字", 100)+"\n", 80) + "- current\n"
	if _, err := RewriteMemory(dir, text); err != nil {
		t.Fatal(err)
	}
	snapshot := ReadMemory(dir)
	if len(snapshot.Lines) != 2 || snapshot.Carried != 1 {
		t.Fatalf("metadata: %d lines, %d carried", len(snapshot.Lines), snapshot.Carried)
	}
	if strings.Contains(snapshot.Prompt, "- old") || !strings.HasSuffix(snapshot.Prompt, "- current") {
		t.Fatalf("wrong prompt slice: %.100s", snapshot.Prompt)
	}
}
