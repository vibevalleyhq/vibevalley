package db

import (
	"embed"
	"fmt"
	"io"
	"io/fs"
	"time"
)

// PlatformScope is the migration tracking scope for the unified platform SQLite database.
const PlatformScope = "platform"

// MigrationsFS embeds all 11 ordered SQLite migration pairs for the unified platform schema.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS

var orderedModules = []string{
	"durable",
	"vault",
	"agent",
	"repo",
	"game",
	"issue",
	"channel",
	"watch",
	"memory",
	"pkm",
	"gateway",
}

// OrderedModules returns a fresh slice of the 11 module names in exact migration chronological order.
func OrderedModules() []string {
	out := make([]string, len(orderedModules))
	copy(out, orderedModules)
	return out
}

func moduleIndex(module string) (int, bool) {
	for i, m := range orderedModules {
		if m == module {
			return i, true
		}
	}
	return 0, false
}

// ScopeFS returns an isolated fs.FS presenting migrations/0001_<module>.{up,down}.sql
// backed by the corresponding module pair in MigrationsFS.
func ScopeFS(module string) (fs.FS, error) {
	idx, ok := moduleIndex(module)
	if !ok {
		return nil, fmt.Errorf("db: unknown migration module %q", module)
	}

	srcPrefix := fmt.Sprintf("migrations/%04d_%s", idx+1, module)
	upData, err := MigrationsFS.ReadFile(srcPrefix + ".up.sql")
	if err != nil {
		return nil, fmt.Errorf("db: read up migration for %q: %w", module, err)
	}
	downData, err := MigrationsFS.ReadFile(srcPrefix + ".down.sql")
	if err != nil {
		return nil, fmt.Errorf("db: read down migration for %q: %w", module, err)
	}

	downName := "0001_" + module + ".down.sql"
	upName := "0001_" + module + ".up.sql"
	migDirInfo := memFileInfo{name: "migrations", dir: true}
	downInfo := memFileInfo{name: downName, size: int64(len(downData))}
	upInfo := memFileInfo{name: upName, size: int64(len(upData))}

	return &memReadDirFS{
		downPath:    "migrations/" + downName,
		upPath:      "migrations/" + upName,
		downData:    downData,
		upData:      upData,
		downInfo:    downInfo,
		upInfo:      upInfo,
		rootEntries: []fs.DirEntry{migDirInfo},
		migEntries:  []fs.DirEntry{downInfo, upInfo},
	}, nil
}

type memReadDirFS struct {
	downPath    string
	upPath      string
	downData    []byte
	upData      []byte
	downInfo    memFileInfo
	upInfo      memFileInfo
	rootEntries []fs.DirEntry
	migEntries  []fs.DirEntry
}

var (
	_ fs.ReadDirFS  = (*memReadDirFS)(nil)
	_ fs.ReadFileFS = (*memReadDirFS)(nil)
	_ fs.StatFS     = (*memReadDirFS)(nil)
)

func (m *memReadDirFS) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	switch name {
	case ".":
		return &memDir{info: memFileInfo{name: ".", dir: true}, entries: m.rootEntries}, nil
	case "migrations":
		return &memDir{info: memFileInfo{name: "migrations", dir: true}, entries: m.migEntries}, nil
	case m.downPath:
		return &memFile{info: m.downInfo, data: m.downData}, nil
	case m.upPath:
		return &memFile{info: m.upInfo, data: m.upData}, nil
	default:
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
}

func (m *memReadDirFS) Stat(name string) (fs.FileInfo, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "stat", Path: name, Err: fs.ErrInvalid}
	}
	switch name {
	case ".":
		return memFileInfo{name: ".", dir: true}, nil
	case "migrations":
		return memFileInfo{name: "migrations", dir: true}, nil
	case m.downPath:
		return m.downInfo, nil
	case m.upPath:
		return m.upInfo, nil
	default:
		return nil, &fs.PathError{Op: "stat", Path: name, Err: fs.ErrNotExist}
	}
}

func (m *memReadDirFS) ReadDir(name string) ([]fs.DirEntry, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrInvalid}
	}
	switch name {
	case ".":
		out := make([]fs.DirEntry, len(m.rootEntries))
		copy(out, m.rootEntries)
		return out, nil
	case "migrations":
		out := make([]fs.DirEntry, len(m.migEntries))
		copy(out, m.migEntries)
		return out, nil
	case m.downPath, m.upPath:
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrInvalid}
	default:
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrNotExist}
	}
}

func (m *memReadDirFS) ReadFile(name string) ([]byte, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	switch name {
	case m.downPath:
		out := make([]byte, len(m.downData))
		copy(out, m.downData)
		return out, nil
	case m.upPath:
		out := make([]byte, len(m.upData))
		copy(out, m.upData)
		return out, nil
	case ".", "migrations":
		return nil, &fs.PathError{Op: "read", Path: name, Err: fs.ErrInvalid}
	default:
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
}

type memFile struct {
	info   memFileInfo
	data   []byte
	offset int
	closed bool
}

var (
	_ fs.File       = (*memFile)(nil)
	_ io.ReadCloser = (*memFile)(nil)
)

func (f *memFile) Stat() (fs.FileInfo, error) {
	if f.closed {
		return nil, &fs.PathError{Op: "stat", Path: f.info.name, Err: fs.ErrClosed}
	}
	return f.info, nil
}

func (f *memFile) Read(p []byte) (int, error) {
	if f.closed {
		return 0, &fs.PathError{Op: "read", Path: f.info.name, Err: fs.ErrClosed}
	}
	if f.offset >= len(f.data) {
		return 0, io.EOF
	}
	n := copy(p, f.data[f.offset:])
	f.offset += n
	return n, nil
}

func (f *memFile) Close() error {
	f.closed = true
	return nil
}

type memDir struct {
	info    memFileInfo
	entries []fs.DirEntry
	offset  int
	closed  bool
}

var _ fs.ReadDirFile = (*memDir)(nil)

func (d *memDir) Stat() (fs.FileInfo, error) {
	if d.closed {
		return nil, &fs.PathError{Op: "stat", Path: d.info.name, Err: fs.ErrClosed}
	}
	return d.info, nil
}

func (d *memDir) Read([]byte) (int, error) {
	return 0, &fs.PathError{Op: "read", Path: d.info.name, Err: fs.ErrInvalid}
}

func (d *memDir) Close() error {
	d.closed = true
	return nil
}

func (d *memDir) ReadDir(n int) ([]fs.DirEntry, error) {
	if d.closed {
		return nil, &fs.PathError{Op: "readdir", Path: d.info.name, Err: fs.ErrClosed}
	}
	if d.offset >= len(d.entries) {
		if n <= 0 {
			return nil, nil
		}
		return nil, io.EOF
	}
	end := len(d.entries)
	if n > 0 && d.offset+n < end {
		end = d.offset + n
	}
	out := make([]fs.DirEntry, end-d.offset)
	copy(out, d.entries[d.offset:end])
	d.offset = end
	return out, nil
}

type memFileInfo struct {
	name string
	size int64
	dir  bool
}

var (
	_ fs.FileInfo = memFileInfo{}
	_ fs.DirEntry = memFileInfo{}
)

func (i memFileInfo) Name() string { return i.name }
func (i memFileInfo) Size() int64  { return i.size }
func (i memFileInfo) Mode() fs.FileMode {
	if i.dir {
		return fs.ModeDir | 0o555
	}
	return 0o444
}
func (i memFileInfo) ModTime() time.Time         { return time.Time{} }
func (i memFileInfo) IsDir() bool                { return i.dir }
func (i memFileInfo) Sys() any                   { return nil }
func (i memFileInfo) Type() fs.FileMode          { return i.Mode().Type() }
func (i memFileInfo) Info() (fs.FileInfo, error) { return i, nil }
