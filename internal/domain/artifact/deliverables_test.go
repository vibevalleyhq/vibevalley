package artifact_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hexops/gotextdiff"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestDeliverablesAllDisplayModesCASDedupAndGotextdiff(t *testing.T) {
	ctx := context.Background()
	var clockMs int64 = 1_700_000_000_000
	dir := t.TempDir()

	svc, err := artifact.NewService(artifact.ServiceConfig{
		Dir: dir,
		Now: func() int64 {
			clockMs += 100
			return clockMs
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	// Verify every contract.ArtifactDisplayMode emits valid ArtifactCardView metadata.
	modes := []contract.ArtifactDisplayMode{
		contract.ArtifactDisplayPage,
		contract.ArtifactDisplaySlides,
		contract.ArtifactDisplayMotion,
		contract.ArtifactDisplayCanvas,
		contract.ArtifactDisplayDashboard,
		contract.ArtifactDisplayWhiteboard,
	}
	for _, mode := range modes {
		res, err := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
			ID:        "art-" + string(mode),
			Title:     "Mode " + string(mode),
			Display:   mode,
			ChannelID: "chan-modes",
			IssueID:   "iss-modes",
			RawHTML:   "<!doctype html><html><body><h1>" + string(mode) + "</h1></body></html>\n",
		})
		if err != nil {
			t.Fatalf("Publish mode %s failed: %v", mode, err)
		}
		if res.Card.Display != mode || res.Card.Version != 1 || res.Card.Body != "html" || len(res.Card.SHA256) != 64 {
			t.Fatalf("unexpected card for mode %s: %+v", mode, res.Card)
		}
	}

	// Publish v1 multi-file TSX deliverable.
	v1Files := map[string]string{
		"src/App.tsx": "import \"./styles.css\";\nimport { Badge } from \"./Badge\";\nexport const App = () => <main><Badge text=\"v1\" /></main>;\n",
		"src/Badge.tsx": `export function Badge({ text }: { text: string }) {
  return <span className="badge">{text}</span>;
}
`,
		"src/Old.tsx":    "export const legacy = true;\n",
		"src/styles.css": ".badge { color: green; }\n",
	}
	v1Res, err := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:        "art-diff",
		Title:     "Diff Target",
		Display:   contract.ArtifactDisplayCanvas,
		ChannelID: "chan-1",
		IssueID:   "iss-1",
		Note:      "initial canvas",
		Bundle: &artifact.CompileRequest{
			Entry: "src/App.tsx",
			Files: v1Files,
		},
	})
	if err != nil {
		t.Fatalf("Publish v1: %v", err)
	}
	if v1Res.BlobDeduplicated {
		t.Fatal("expected v1 blob not deduplicated")
	}

	// Publish v2 with identical contents under a different artifact ID -> CAS must deduplicate!
	dupRes, err := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:      "art-dup",
		Title:   "Diff Target",
		Display: contract.ArtifactDisplayCanvas,
		Bundle: &artifact.CompileRequest{
			Entry: "src/App.tsx",
			Files: v1Files,
		},
	})
	if err != nil {
		t.Fatalf("Publish dup: %v", err)
	}
	if !dupRes.BlobDeduplicated {
		t.Fatal("expected identical compiled HTML blob to be deduplicated in CAS")
	}
	if dupRes.Version.HTMLSHA256 != v1Res.Version.HTMLSHA256 {
		t.Fatalf("expected matching SHA256: %s != %s", dupRes.Version.HTMLSHA256, v1Res.Version.HTMLSHA256)
	}

	blobsBeforeV2 := svc.CAS.Stats().UniqueBlobs

	// Publish v2 of art-diff: edit src/Badge.tsx, add src/Footer.tsx, remove src/Old.tsx, keep src/styles.css unchanged.
	v2Files := map[string]string{
		"src/App.tsx": v1Files["src/App.tsx"],
		"src/Badge.tsx": `export function Badge({ text }: { text: string }) {
  return <span className="badge active">{text}!</span>;
}
`,
		"src/Footer.tsx": "export const Footer = () => <footer>v2</footer>;\n",
		"src/styles.css": v1Files["src/styles.css"],
	}
	v2Res, err := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:      "art-diff",
		Note:    "updated badge & footer",
		Display: contract.ArtifactDisplayCanvas,
		Bundle: &artifact.CompileRequest{
			Entry: "src/App.tsx",
			Files: v2Files,
		},
	})
	if err != nil {
		t.Fatalf("Publish v2: %v", err)
	}
	if v2Res.Version.Version != 2 {
		t.Fatalf("expected version 2, got %d", v2Res.Version.Version)
	}

	// Compute exact line-level unified diffs via hexops/gotextdiff.
	diff, err := svc.Deliverables.DiffVersions(ctx, "art-diff", 1, 2)
	if err != nil {
		t.Fatalf("DiffVersions: %v", err)
	}
	if !diff.HasChanges || diff.HTMLDiff.Equal {
		t.Fatal("expected changes between v1 and v2")
	}
	if !strings.Contains(diff.HTMLDiff.Unified, "--- v1/bundle.html") || !strings.Contains(diff.HTMLDiff.Unified, "+++ v2/bundle.html") {
		t.Fatalf("unexpected HTML unified diff header:\n%s", diff.HTMLDiff.Unified)
	}

	byPath := make(map[string]artifact.FileDiff, len(diff.FileDiffs))
	for _, fd := range diff.FileDiffs {
		byPath[fd.Path] = fd
	}
	if byPath["src/Badge.tsx"].Status != "modified" {
		t.Fatalf("expected src/Badge.tsx modified, got %+v", byPath["src/Badge.tsx"])
	}
	if !strings.Contains(byPath["src/Badge.tsx"].Diff.Unified, `-  return <span className="badge">{text}</span>;`) ||
		!strings.Contains(byPath["src/Badge.tsx"].Diff.Unified, `+  return <span className="badge active">{text}!</span>;`) {
		t.Fatalf("expected exact line diff for Badge.tsx, got:\n%s", byPath["src/Badge.tsx"].Diff.Unified)
	}
	if gotextdiff.ApplyEdits(v1Files["src/Badge.tsx"], byPath["src/Badge.tsx"].Diff.Edits) != v2Files["src/Badge.tsx"] {
		t.Fatal("gotextdiff ApplyEdits did not reconstruct v2 Badge.tsx")
	}
	if byPath["src/Footer.tsx"].Status != "added" || byPath["src/Old.tsx"].Status != "deleted" {
		t.Fatalf("unexpected add/delete statuses: footer=%+v old=%+v", byPath["src/Footer.tsx"], byPath["src/Old.tsx"])
	}
	if byPath["src/styles.css"].Status != "unchanged" || !byPath["src/styles.css"].Diff.Equal {
		t.Fatalf("expected src/styles.css unchanged, got %+v", byPath["src/styles.css"])
	}
	if byPath["src/App.tsx"].Status != "unchanged" {
		t.Fatalf("expected src/App.tsx unchanged, got %+v", byPath["src/App.tsx"])
	}
	// Only Badge.tsx, Footer.tsx, and new HTML bundle should add 3 new blobs (App.tsx & styles.css deduplicated!).
	if gotNew := svc.CAS.Stats().UniqueBlobs - blobsBeforeV2; gotNew != 3 {
		t.Fatalf("expected 3 new CAS blobs for v2 (deduping unchanged App.tsx & styles.css), got %d", gotNew)
	}

	// Verify disk persistence across service restart.
	reopened, err := artifact.NewService(artifact.ServiceConfig{Dir: dir})
	if err != nil {
		t.Fatalf("reopen NewService: %v", err)
	}
	meta, htmlBytes, err := reopened.Deliverables.GetVersion(ctx, "art-diff", 2)
	if err != nil {
		t.Fatalf("reopened GetVersion: %v", err)
	}
	if meta.HTMLSHA256 != v2Res.Version.HTMLSHA256 || len(htmlBytes) == 0 {
		t.Fatalf("reopened deliverable mismatch: %+v", meta)
	}

	// Verify CAS tamper detection catches on-disk blob corruption.
	blobPath := filepath.Join(dir, "blobs", v2Res.Version.HTMLSHA256)
	if err := os.WriteFile(blobPath, []byte("tampered"), 0o644); err != nil {
		t.Fatalf("corrupt blob: %v", err)
	}
	if _, err := reopened.CAS.Get(v2Res.Version.HTMLSHA256); !errors.Is(err, artifact.ErrCorruptedBlob) {
		t.Fatalf("expected ErrCorruptedBlob on tampered file, got %v", err)
	}
}

func TestRawHTMLPolicyValidationRejectsUnsafeMarkupBeforePersist(t *testing.T) {
	ctx := context.Background()
	svc, err := artifact.NewService(artifact.ServiceConfig{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	unsafeHTML := `<!doctype html>
<html>
<head>
  <script src="https://evil.example.com/steal.js"></script>
</head>
<body>
  <iframe src="https://workbench.internal"></iframe>
</body>
</html>`

	_, pubErr := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:      "art-unsafe",
		RawHTML: unsafeHTML,
	})
	if !errors.Is(pubErr, artifact.ErrHTMLPolicyViolation) {
		t.Fatalf("expected ErrHTMLPolicyViolation, got %v", pubErr)
	}
	var ce *artifact.CompileError
	if !errors.As(pubErr, &ce) || len(ce.Diagnostics) < 2 {
		t.Fatalf("expected >= 2 HTML policy diagnostics, got %+v", pubErr)
	}
	if ce.Diagnostics[0].Line != 4 || ce.Diagnostics[1].Line != 7 {
		t.Fatalf("expected exact line numbers 4 and 7, got %+v", ce.Diagnostics)
	}
	if len(svc.Deliverables.ListCards(ctx, artifact.DeliverableFilter{})) != 0 {
		t.Fatal("unsafe HTML must not persist any deliverable card")
	}
}
