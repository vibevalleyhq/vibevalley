package jsonx

import (
	"strings"
	"testing"
)

func TestMapStringsKeepsOrderAndTokens(t *testing.T) {
	raw := []byte(`{"z":"secret-value","a":[1,2.5,true,null,{"k":"x secret-value y"}],"secret-value":{}}`)
	out, changed, err := MapStrings(raw, func(s string) string { return strings.ReplaceAll(s, "secret-value", "[redacted]") })
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	want := `{"z":"[redacted]","a":[1,2.5,true,null,{"k":"x [redacted] y"}],"[redacted]":{}}`
	if string(out) != want {
		t.Fatalf("got %s", out)
	}
	same, changed, _ := MapStrings(raw, func(s string) string { return s })
	if changed || string(same) != string(raw) {
		t.Fatalf("unchanged input must come back as is")
	}
}
