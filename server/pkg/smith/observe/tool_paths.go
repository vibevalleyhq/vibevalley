package observe

// File paths of a file tool's call (observe/tool-paths.ts).

// pathKeys name a file, in the order ClassifyTool's Detail reads them.
var pathKeys = []string{"path", "file_path", "filePath", "file"}

// inputPath is a file tool's one path: the first non-empty pathKeys string.
func inputPath(inputJSON string) []string {
	input := asRecord(parseJSON(inputJSON))
	for _, key := range pathKeys {
		if value, ok := nonEmptyString(input[key]); ok {
			return []string{value}
		}
	}
	return nil
}

// fileChangePaths reads a codex fileChange's paths. Its input is the item's
// changes array (codex/item-detail.ts), recorded on 0.160.1 as
// [{path, kind: {type: "add" | "delete" | "update", move_path?}, diff}]:
// absolute paths, sorted by path, and move_path (null on an update that does
// not rename) the rename's target.
func fileChangePaths(inputJSON string) []string {
	changes, _ := parseJSON(inputJSON).([]any)
	var paths []string
	for _, raw := range changes {
		change := asRecord(raw)
		for _, value := range []any{change["path"], asRecord(change["kind"])["move_path"]} {
			if path, ok := nonEmptyString(value); ok {
				paths = append(paths, path)
			}
		}
	}
	return paths
}

// pathUnder is a tool whose one path is under key, a key pathKeys does not list.
func pathUnder(key string) func(string) []string {
	return func(inputJSON string) []string {
		if value, ok := nonEmptyString(asRecord(parseJSON(inputJSON))[key]); ok {
			return []string{value}
		}
		return nil
	}
}

// pathsByRuntime: where a runtime's file tool keeps its paths, when not under one of pathKeys.
var pathsByRuntime = map[string]map[string]func(string) []string{
	// The notebook it edits; never a detail before paths, now the first of them.
	"claude": {"NotebookEdit": pathUnder("notebook_path")},
	"codex":  {"fileChange": fileChangePaths},
}

// filePathsOf is the file paths a file tool's call involves, each once, in the runtime's order.
func filePathsOf(runtime, tool, inputJSON string) []string {
	read, ok := pathsByRuntime[runtime][tool]
	if !ok {
		read = inputPath
	}
	seen := map[string]bool{}
	var out []string
	for _, path := range read(inputJSON) {
		if !seen[path] {
			seen[path] = true
			out = append(out, path)
		}
	}
	return out
}
