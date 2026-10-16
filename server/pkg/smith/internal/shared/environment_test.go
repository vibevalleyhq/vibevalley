package shared

import (
	"reflect"
	"slices"
	"testing"
)

func TestWindowsEnvironmentFoldsNames(t *testing.T) {
	inherited := []string{"Path=one", "PATH=two", "Token=secret", "KEEP=ok"}
	overlay := map[string]*string{"path": strp("new"), "TOKEN": nil, "MISSING": nil}
	got := EnvironmentFrom(overlay, inherited, "windows")
	slices.Sort(got)
	if want := []string{"KEEP=ok", "path=new"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if want := []string{"Path=one", "PATH=two", "Token=secret", "KEEP=ok"}; !reflect.DeepEqual(inherited, want) {
		t.Fatalf("inherited changed: %v", inherited)
	}
}

func TestPosixEnvironmentIsCaseSensitive(t *testing.T) {
	inherited := []string{"TOKEN=upper", "token=lower"}
	if got := EnvironmentFrom(map[string]*string{"TOKEN": nil}, inherited, "linux"); !reflect.DeepEqual(got, []string{"token=lower"}) {
		t.Fatalf("got %v", got)
	}
	if got := EnvironmentFrom(nil, inherited, "linux"); !reflect.DeepEqual(got, inherited) {
		t.Fatalf("omitted env changed the inherited one: %v", got)
	}
	if !reflect.DeepEqual(inherited, []string{"TOKEN=upper", "token=lower"}) {
		t.Fatalf("inherited changed: %v", inherited)
	}
}

func TestEnvironmentOverridesRemovesAndKeepsEmpty(t *testing.T) {
	t.Setenv("OAR_ENV_REMOVE", "inherited")
	t.Setenv("OAR_ENV_OVERRIDE", "inherited")
	t.Setenv("OAR_ENV_KEEP", "inherited")
	got := Environment(map[string]*string{"OAR_ENV_REMOVE": nil, "OAR_ENV_OVERRIDE": strp("replacement"), "OAR_ENV_EMPTY": strp("")})
	seen := map[string]string{}
	for _, entry := range got {
		for index := range entry {
			if entry[index] == '=' {
				seen[entry[:index]] = entry[index+1:]
				break
			}
		}
	}
	if _, ok := seen["OAR_ENV_REMOVE"]; ok {
		t.Error("a removed variable is inherited")
	}
	if seen["OAR_ENV_OVERRIDE"] != "replacement" || seen["OAR_ENV_KEEP"] != "inherited" {
		t.Errorf("got %v", seen)
	}
	if value, ok := seen["OAR_ENV_EMPTY"]; !ok || value != "" {
		t.Error("an empty value is not set")
	}
}

func strp(value string) *string { return &value }
