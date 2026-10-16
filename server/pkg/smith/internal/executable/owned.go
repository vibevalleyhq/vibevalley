package executable

import (
	"os"
	"sync"
)

// Go has no process `exit` hook, so the TS backstop (ownership.ts: every
// owned child's group and descendants SIGKILLed when the host exits) is an
// explicit call: a host that may exit without disposing its sessions calls
// KillOwned on its shutdown path (after a signal, before os.Exit).
var owned = struct {
	sync.Mutex
	set map[*os.Process]struct{}
}{set: map[*os.Process]struct{}{}}

func track(process *os.Process) {
	owned.Lock()
	owned.set[process] = struct{}{}
	owned.Unlock()
}

func forget(process *os.Process) {
	owned.Lock()
	delete(owned.set, process)
	owned.Unlock()
}

// KillOwned SIGKILLs every process this package started that is still
// running, with its process group and its descendants that left the group.
func KillOwned() {
	owned.Lock()
	processes := make([]*os.Process, 0, len(owned.set))
	for process := range owned.set {
		processes = append(processes, process)
	}
	owned.Unlock()
	table := ReadProcessTable()
	for _, process := range processes {
		KillEntries(DescendantsOf(table, process.Pid), table)
		SignalGroup(process, true)
	}
}

// Track adds a process started outside this package (a login command) to
// the set KillOwned takes down; Forget removes it once it has been waited for.
func Track(process *os.Process) { track(process) }

// Forget removes a process Track added.
func Forget(process *os.Process) { forget(process) }
