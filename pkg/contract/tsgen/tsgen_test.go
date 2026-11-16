package tsgen

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestGenerateContractDirAndTopologicalOrder(t *testing.T) {
	pkg, err := ParseDir("..")
	if err != nil {
		t.Fatalf("ParseDir(..): %v", err)
	}
	if pkg.Name != "contract" {
		t.Fatalf("expected package contract, got %q", pkg.Name)
	}

	pos := make(map[string]int, len(pkg.Decls))
	for i, d := range pkg.Decls {
		pos[d.Name] = i
	}

	// Verify all expected declarations are present and topologically ordered.
	mustOrder := [][2]string{
		{"PrincipalKind", "Principal"},
		{"ControlStatus", "ControlOutcome"},
		{"UsageTotals", "DelegationResult"},
		{"MountFile", "MountSyncRequest"},
		{"MountFile", "MountSyncResult"},
		{"MountConflict", "MountSyncResult"},
		{"PermissionPolicy", "PermissionEvaluation"},
		{"PermissionVerdict", "PermissionEvaluation"},
		{"IssueStatus", "IssueView"},
		{"RubricSpec", "IssueView"},
		{"ChannelEventKind", "ChannelEventView"},
		{"InboxItemKind", "InboxItemView"},
		{"ArtifactDisplayMode", "ArtifactCardView"},
		{"PermissionPolicy", "ApprovalPromptView"},
		{"IssueView", "SpaceView"},
		{"InboxItemView", "SpaceView"},
		{"ApprovalPromptView", "SpaceView"},
		{"DreamProposalView", "SpaceView"},
	}
	for _, pair := range mustOrder {
		a, okA := pos[pair[0]]
		b, okB := pos[pair[1]]
		if !okA || !okB {
			t.Fatalf("missing declaration in pair %v: okA=%v okB=%v", pair, okA, okB)
		}
		if a >= b {
			t.Errorf("expected %s (%d) before %s (%d)", pair[0], a, pair[1], b)
		}
	}

	// Non-struct/enum declarations (ExecutionEnv interface, DefaultMaxImage* numeric consts) must be excluded.
	for _, excluded := range []string{"ExecutionEnv", "DefaultMaxImageWidth", "DefaultMaxImageHeight", "DefaultMaxImageBytes"} {
		if _, exists := pos[excluded]; exists {
			t.Errorf("did not expect %q in emitted declarations", excluded)
		}
	}

	out, err := Emit(pkg)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}

	shapes := string(out.ShapesTS)
	schema := string(out.SchemaTS)

	// Verify specific shape conversions.
	checksShapes := []string{
		`import type { BlockId, IssueId, SessionId } from "../common/shapes";`,
		`export const PrincipalKindValues = ["user_device", "machine_node", "session_token"] as const;`,
		`export type PrincipalKind = (typeof PrincipalKindValues)[number];`,
		"  sessionId?: SessionId;",
		"  stdin?: string;",
		"  costMicros?: number;",
		"  metadata?: Record<string, string>;",
		"  sessionId: string;", // MountSyncRequest stays plain string on Request boundary.
		"  rubric?: RubricSpec;",
		"  blockId?: BlockId;",
		"  issueId?: IssueId;",
		"  sessionId: SessionId;", // ApprovalPromptView is branded.
		"  onlineMachines: string[];",
	}
	for _, want := range checksShapes {
		if !strings.Contains(shapes, want) {
			t.Errorf("shapes.ts missing %q\n--- shapes.ts ---\n%s", want, shapes)
		}
	}

	checksSchema := []string{
		`import { z } from "zod";`,
		`import type { Codec } from "../codec";`,
		`import { BlockId, IssueId, SessionId } from "../common/schema";`,
		`import * as T from "./shapes";`,
		`export const PrincipalKind = z.enum(T.PrincipalKindValues) satisfies Codec<T.PrincipalKind>;`,
		`  sessionId: z.exactOptional(SessionId),`,
		`  stdin: z.exactOptional(z.string()),`,
		`  costMicros: z.exactOptional(z.number().int()),`,
		`  metadata: z.exactOptional(z.record(z.string(), z.string())),`,
		`  rubric: z.exactOptional(RubricSpec),`,
		`  blockId: z.exactOptional(BlockId),`,
		`  issueId: z.exactOptional(IssueId),`,
		`  sessionId: SessionId,`,
		`) satisfies Codec<T.SpaceView>;`,
	}
	for _, want := range checksSchema {
		if !strings.Contains(schema, want) {
			t.Errorf("schema.ts missing %q\n--- schema.ts ---\n%s", want, schema)
		}
	}

	// Verify JSON marshaled by real Go contract structs has exact matching keys and types.
	sample := contract.SpaceView{
		Rev: 12,
		Issues: []contract.IssueView{{
			ID:          "iss_1",
			Title:       "Wire codegen",
			Status:      contract.IssueInProgress,
			RepoID:      "repo_1",
			SessionID:   "sess_1",
			Rubric:      &contract.RubricSpec{Markdown: "- passes", MaxIterations: 3},
			UpdatedAtMs: 1763300000000,
		}},
		Inbox:          []contract.InboxItemView{},
		Approvals:      []contract.ApprovalPromptView{},
		Dreams:         []contract.DreamProposalView{},
		OnlineMachines: []string{"m1"},
	}
	raw, err := json.Marshal(sample)
	if err != nil {
		t.Fatalf("json.Marshal(SpaceView): %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	for _, key := range []string{"rev", "issues", "inbox", "approvals", "dreams", "onlineMachines"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("SpaceView JSON missing key %q", key)
		}
	}
}

func TestDeterministicAcrossInputOrderAndRepeatedRuns(t *testing.T) {
	fileA := SourceFile{
		Name: "a_views.go",
		Content: []byte(`package sample

// Outer declared before Inner in alphabetical file order.
type Outer struct {
	Inner     Inner     ` + "`json:\"inner\"`" + `
	OptInner  *Inner    ` + "`json:\"optInner,omitempty\"`" + `
	NullInner *Inner    ` + "`json:\"nullInner\"`" + `
	Kind      Kind      ` + "`json:\"kind\"`" + `
	Data      []byte    ` + "`json:\"data,omitempty\"`" + `
	Hidden    string    ` + "`json:\"-\"`" + `
	DashField string    ` + "`json:\"-,\"`" + `
	unexp     string
}
`),
	}
	fileB := SourceFile{
		Name: "b_types.go",
		Content: []byte(`package sample

type Kind string

const (
	KindOne Kind = "one"
	KindTwo      = Kind("two")
)

type Inner struct {
	Count   int64   ` + "`json:\"count\"`" + `
	Score   float64 ` + "`json:\"score\"`" + `
	Session string  ` + "`json:\"sessionId\"`" + `
}
`),
	}

	p1, err := ParseFiles([]SourceFile{fileA, fileB})
	if err != nil {
		t.Fatalf("ParseFiles order 1: %v", err)
	}
	p2, err := ParseFiles([]SourceFile{fileB, fileA})
	if err != nil {
		t.Fatalf("ParseFiles order 2: %v", err)
	}
	out1, err := Emit(p1)
	if err != nil {
		t.Fatalf("Emit 1: %v", err)
	}
	out2, err := Emit(p2)
	if err != nil {
		t.Fatalf("Emit 2: %v", err)
	}
	if !bytes.Equal(out1.ShapesTS, out2.ShapesTS) || !bytes.Equal(out1.SchemaTS, out2.SchemaTS) {
		t.Fatal("non-deterministic output across shuffled file slice")
	}

	shapes := string(out1.ShapesTS)
	schema := string(out1.SchemaTS)

	// Topological order: Kind and Inner must precede Outer.
	idxKind := strings.Index(shapes, "export type Kind =")
	idxInner := strings.Index(shapes, "export interface Inner")
	idxOuter := strings.Index(shapes, "export interface Outer")
	if idxKind < 0 || idxInner < 0 || idxOuter < 0 || idxKind > idxOuter || idxInner > idxOuter {
		t.Fatalf("unexpected topological order in shapes.ts:\n%s", shapes)
	}

	if strings.Contains(shapes, "Hidden") || strings.Contains(shapes, "unexp") {
		t.Errorf("shapes.ts should omit json:\"-\" and unexported fields:\n%s", shapes)
	}
	if !strings.Contains(shapes, `"-": string;`) {
		t.Errorf("shapes.ts should keep json:\"-,\":\n%s", shapes)
	}
	if !strings.Contains(shapes, "optInner?: Inner;") || !strings.Contains(shapes, "nullInner: Inner | null;") {
		t.Errorf("shapes.ts pointer/omitempty mismatch:\n%s", shapes)
	}
	if !strings.Contains(schema, "optInner: z.exactOptional(Inner),") || !strings.Contains(schema, "nullInner: z.nullable(Inner),") {
		t.Errorf("schema.ts pointer/omitempty mismatch:\n%s", schema)
	}
	if !strings.Contains(schema, "score: z.number(),") || !strings.Contains(schema, "count: z.number().int(),") {
		t.Errorf("schema.ts numeric type mismatch:\n%s", schema)
	}
	if !strings.Contains(shapes, "data?: string;") || !strings.Contains(schema, "data: z.exactOptional(z.string()),") {
		t.Errorf("[]byte must map to string:\n%s\n%s", shapes, schema)
	}
}

func TestStructOnlyUsesTypeOnlyShapesImportAndWrapsLongEnums(t *testing.T) {
	file := SourceFile{
		Name: "types.go",
		Content: []byte(`package plain

type Plain struct {
	Name string ` + "`json:\"name\"`" + `
}
`),
	}
	pkg, err := ParseFiles([]SourceFile{file})
	if err != nil {
		t.Fatalf("ParseFiles: %v", err)
	}
	out, err := Emit(pkg)
	if err != nil {
		t.Fatalf("Emit: %v", err)
	}
	if !strings.Contains(string(out.SchemaTS), `import type * as T from "./shapes";`) {
		t.Fatalf("expected type-only import when no enums exist:\n%s", string(out.SchemaTS))
	}
	if strings.Contains(string(out.ShapesTS), "common/shapes") {
		t.Fatalf("unexpected branded import when no branded fields exist:\n%s", string(out.ShapesTS))
	}

	// Verify >160-char enum Values array wraps cleanly.
	longEnum := SourceFile{
		Name: "long.go",
		Content: []byte(`package longpkg

type LongEnum string

const (
	L1 LongEnum = "very_long_variant_alpha_00000000000000001"
	L2 LongEnum = "very_long_variant_bravo_00000000000000002"
	L3 LongEnum = "very_long_variant_charlie_000000000000003"
	L4 LongEnum = "very_long_variant_delta_00000000000000004"
)
`),
	}
	longPkg, err := ParseFiles([]SourceFile{longEnum})
	if err != nil {
		t.Fatalf("ParseFiles longEnum: %v", err)
	}
	longOut, err := Emit(longPkg)
	if err != nil {
		t.Fatalf("Emit longEnum: %v", err)
	}
	if !strings.Contains(string(longOut.ShapesTS), "export const LongEnumValues = [\n") {
		t.Fatalf("expected multiline wrapping for >160-char enum values:\n%s", string(longOut.ShapesTS))
	}
}

func TestCyclicStructReturnsError(t *testing.T) {
	cycle := SourceFile{
		Name: "cycle.go",
		Content: []byte(`package cyc

type A struct {
	B B ` + "`json:\"b\"`" + `
}

type B struct {
	A A ` + "`json:\"a\"`" + `
}
`),
	}
	if _, err := ParseFiles([]SourceFile{cycle}); err == nil || !strings.Contains(err.Error(), "cyclic") {
		t.Fatalf("expected cycle error, got %v", err)
	}
}

func TestRunCheckAndWriteRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	contractDir := filepath.Join(tmp, ContractSubdir)
	if err := os.MkdirAll(contractDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(contractDir, "sample.go"), []byte("package sample\ntype Ping struct {\n\tOK bool `json:\"ok\"`\n}\n"), 0o644); err != nil {
		t.Fatalf("write sample.go: %v", err)
	}

	err := Run(Options{RepoRoot: tmp, Check: true})
	if !errors.Is(err, ErrOutOfDate) {
		t.Fatalf("expected ErrOutOfDate before write, got %v", err)
	}

	if err := Run(Options{RepoRoot: tmp, Check: false}); err != nil {
		t.Fatalf("Run write: %v", err)
	}
	if err := Run(Options{RepoRoot: tmp, Check: true}); err != nil {
		t.Fatalf("Run check after write: %v", err)
	}
}
