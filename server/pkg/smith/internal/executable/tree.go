package executable

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// ProcessEntry is one process in the table; Start tells it from a later
// process given the same pid.
type ProcessEntry struct {
	Pid   int
	Ppid  int
	Pgid  int
	Start string
	// Resident set in bytes (only from the resources reader).
	RSS int64
}

// ProcessTable is the process table at one moment, by pid.
type ProcessTable map[int]ProcessEntry

// readStat reads /proc/<pid>/stat's ppid, pgrp, starttime and rss pages.
func readStat(pid int, pageSize int64) (ProcessEntry, bool) {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return ProcessEntry{}, false
	}
	text := string(stat)
	close := strings.LastIndex(text, ")")
	if close < 0 || close+2 > len(text) {
		return ProcessEntry{}, false
	}
	fields := strings.Split(text[close+2:], " ")
	if len(fields) < 22 {
		return ProcessEntry{}, false
	}
	ppid, err1 := strconv.Atoi(fields[1])
	pgid, err2 := strconv.Atoi(fields[2])
	pages, err3 := strconv.ParseInt(fields[21], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return ProcessEntry{}, false
	}
	return ProcessEntry{Pid: pid, Ppid: ppid, Pgid: pgid, Start: fields[19], RSS: pages * pageSize}, true
}

func readProcfs() (ProcessTable, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	page := int64(os.Getpagesize())
	table := ProcessTable{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if stat, ok := readStat(pid, page); ok {
			table[pid] = stat
		}
	}
	return table, nil
}

var psLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$`)
var psRSSLine = regexp.MustCompile(`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$`)

func readPs(columns string, parse func(match []string) ProcessEntry, pattern *regexp.Regexp) (ProcessTable, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ps", "-A", "-o", columns)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	table := ProcessTable{}
	for _, line := range strings.Split(string(output), "\n") {
		if match := pattern.FindStringSubmatch(line); match != nil {
			entry := parse(match)
			table[entry.Pid] = entry
		}
	}
	return table, nil
}

// ReadProcessTable is the process table now; empty when it cannot be read.
func ReadProcessTable() ProcessTable {
	var table ProcessTable
	var err error
	switch runtime.GOOS {
	case "windows":
		return ProcessTable{}
	case "linux":
		table, err = readProcfs()
	default:
		table, err = readPs("pid=,ppid=,pgid=,lstart=", func(match []string) ProcessEntry {
			pid, _ := strconv.Atoi(match[1])
			ppid, _ := strconv.Atoi(match[2])
			pgid, _ := strconv.Atoi(match[3])
			return ProcessEntry{Pid: pid, Ppid: ppid, Pgid: pgid, Start: match[4]}
		}, psLine)
	}
	if err != nil {
		return ProcessTable{}
	}
	return table
}

// DescendantsOf is every process below pid in table.
func DescendantsOf(table ProcessTable, pid int) []ProcessEntry {
	children := map[int][]ProcessEntry{}
	for _, entry := range table {
		children[entry.Ppid] = append(children[entry.Ppid], entry)
	}
	var found []ProcessEntry
	seen := map[int]bool{pid: true}
	pending := []int{pid}
	for len(pending) > 0 {
		parent := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		for _, child := range children[parent] {
			if !seen[child.Pid] {
				seen[child.Pid] = true
				found = append(found, child)
				pending = append(pending, child.Pid)
			}
		}
	}
	return found
}

// KillEntries SIGKILLs each entry table (read just before) shows still
// running as the same process, and the process group each belongs to now.
// Never the host, nor its group.
func KillEntries(entries []ProcessEntry, table ProcessTable) {
	host := os.Getpid()
	hostGroup := -1
	if entry, ok := table[host]; ok {
		hostGroup = entry.Pgid
	}
	groups := map[int]bool{}
	pids := map[int]bool{}
	for _, entry := range entries {
		current, ok := table[entry.Pid]
		if !ok || current.Start != entry.Start || current.Pid == host {
			continue
		}
		pids[current.Pid] = true
		if current.Pgid > 1 && current.Pgid != hostGroup {
			groups[current.Pgid] = true
		}
	}
	for group := range groups {
		killGroup(group)
	}
	for pid := range pids {
		killPid(pid)
	}
}

// Resources is the resident memory of a process tree.
type Resources struct {
	RSS       int64
	Processes int
}

func readResidentTable() (ProcessTable, error) {
	switch runtime.GOOS {
	case "windows":
		return nil, os.ErrNotExist
	case "linux":
		return readProcfs()
	default:
		return readPs("pid=,ppid=,pgid=,rss=", func(match []string) ProcessEntry {
			pid, _ := strconv.Atoi(match[1])
			ppid, _ := strconv.Atoi(match[2])
			pgid, _ := strconv.Atoi(match[3])
			rss, _ := strconv.ParseInt(match[4], 10, 64)
			return ProcessEntry{Pid: pid, Ppid: ppid, Pgid: pgid, RSS: rss * 1024}
		}, psRSSLine)
	}
}

// ProcessTreeResources is the resident memory of pid, the group it leads and
// its descendants. nil when pid is gone, the table cannot be read, and on Windows.
func ProcessTreeResources(pid int) *Resources {
	table, err := readResidentTable()
	if err != nil {
		return nil
	}
	root, ok := table[pid]
	if !ok {
		return nil
	}
	members := map[int]ProcessEntry{pid: root}
	for _, entry := range table {
		if entry.Pgid == pid {
			members[entry.Pid] = entry
		}
	}
	for _, entry := range DescendantsOf(table, pid) {
		members[entry.Pid] = table[entry.Pid]
	}
	resources := &Resources{Processes: len(members)}
	for _, member := range members {
		resources.RSS += member.RSS
	}
	return resources
}
