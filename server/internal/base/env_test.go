package base

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseEnvAsNode(t *testing.T) {
	got := ParseEnv("# the voice\nAGORA_APP_ID=abc\nexport DEEPSEEK_API_KEY='sk-1 #2'\n\nA = spaced  # note\nB=\"two\\nlines\"\nC=\"multi\nline\"\nD=\nA=again\r\nE=`tick`\nbroken line\n")
	want := [][2]string{
		{"AGORA_APP_ID", "abc"}, {"DEEPSEEK_API_KEY", "sk-1 #2"}, {"A", "again"}, {"B", "two\nlines"}, {"C", "multi\nline"},
		{"D", ""}, {"E", "tick"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseEnv = %q, want %q", got, want)
	}
}

func TestLoadEnvFileKeepsWhatIsSet(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("VIBEVALLEY_TEST_ENV_SET=file\nVIBEVALLEY_TEST_ENV_NEW=file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIBEVALLEY_TEST_ENV_SET", "process")
	t.Setenv("VIBEVALLEY_TEST_ENV_NEW", "")
	os.Unsetenv("VIBEVALLEY_TEST_ENV_NEW")
	if err := LoadEnvFile(path); err != nil {
		t.Fatal(err)
	}
	if v := os.Getenv("VIBEVALLEY_TEST_ENV_SET"); v != "process" {
		t.Fatalf("set variable overwritten: %q", v)
	}
	if v := os.Getenv("VIBEVALLEY_TEST_ENV_NEW"); v != "file" {
		t.Fatalf("new variable = %q", v)
	}
	if err := LoadEnvFile(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatalf("missing file: %v", err)
	}
}

func TestDBPathFromEnv(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{"": "", "memory": ":memory:", dir: filepath.Join(dir, "farm.db"), "/x/farm.db": "/x/farm.db"}
	for in, want := range cases {
		if got := dbPathFrom(in); got != want {
			t.Errorf("dbPathFrom(%q) = %q, want %q", in, got, want)
		}
	}
}
