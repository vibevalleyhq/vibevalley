package cli

import (
	"fmt"
	"strconv"
	"strings"
)

// args is one command's parsed command line: positionals and flags.
// `--name value`, `--name=value` and boolean `--name` are accepted;
// repeated value flags accumulate (`--image a --image b`).
type args struct {
	positional []string
	values     map[string][]string
	booleans   map[string]bool
}

// parseArgs reads raw against the flags the command declares: valueFlags
// take a value, boolFlags none. An unknown flag is an error.
func parseArgs(raw []string, valueFlags, boolFlags []string) (args, error) {
	parsed := args{values: map[string][]string{}, booleans: map[string]bool{}}
	takes := map[string]bool{}
	for _, flag := range valueFlags {
		takes[flag] = true
	}
	known := map[string]bool{}
	for _, flag := range boolFlags {
		known[flag] = true
	}
	for i := 0; i < len(raw); i++ {
		arg := raw[i]
		if arg == "--" {
			parsed.positional = append(parsed.positional, raw[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "--") || arg == "-" {
			parsed.positional = append(parsed.positional, arg)
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		switch {
		case takes[name]:
			if !hasValue {
				if i+1 >= len(raw) {
					return parsed, fmt.Errorf("option '--%s <value>' argument missing", name)
				}
				i++
				value = raw[i]
			}
			parsed.values[name] = append(parsed.values[name], value)
		case known[name]:
			parsed.booleans[name] = true
		default:
			return parsed, fmt.Errorf("unknown option '--%s'", name)
		}
	}
	return parsed, nil
}

func (a args) value(name string) (string, bool) {
	values := a.values[name]
	if len(values) == 0 {
		return "", false
	}
	return values[len(values)-1], true
}

func (a args) flag(name string) bool { return a.booleans[name] }

func (a args) arg(index int) (string, bool) {
	if index >= len(a.positional) {
		return "", false
	}
	return a.positional[index], true
}

// positiveMs reads a positive integer millisecond flag; ok false with no flag.
func (a args) positiveMs(name string) (int64, bool, error) {
	text, ok := a.value(name)
	if !ok {
		return 0, false, nil
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil || value <= 0 {
		return 0, true, fmt.Errorf("--%s must be a positive integer number of milliseconds", name)
	}
	return value, true, nil
}

// nonnegative reads a nonnegative integer flag.
func (a args) nonnegative(name string) (int, bool, error) {
	text, ok := a.value(name)
	if !ok {
		return 0, false, nil
	}
	value, err := strconv.Atoi(text)
	if err != nil || value < 0 {
		return 0, true, fmt.Errorf("--%s must be a nonnegative integer", name)
	}
	return value, true, nil
}
