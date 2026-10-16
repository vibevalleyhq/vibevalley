package acp_test

// Ported from tests/acp/acp-session-images.test.ts.

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func imageFile(t *testing.T) (string, string) {
	dir := t.TempDir()
	image := filepath.Join(dir, "shot one.png")
	if err := os.WriteFile(image, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	return image, (&url.URL{Scheme: "file", Path: image}).String()
}

func TestImagesGoAsImageBlocksBeforeTheText(t *testing.T) {
	image, href := imageFile(t)
	session := start(t, nil)
	if !session.Capabilities().Images {
		t.Fatal("images advertised")
	}
	run := promptAndWait(t, session, "look", observe.PromptRunOptions{Images: []oar.InputImage{{Path: image}}})
	if run.Kind != "ended" || run.Text != "echo:[image image/png "+href+"] look" {
		t.Fatalf("run %+v", run)
	}
	if queued := queue(t, session, "again", oar.InputOptions{Images: []oar.InputImage{{Path: image}}}); queued.Kind != "accepted" {
		t.Fatal(queued.Kind)
	}
}

func TestAgentWithoutImagePromptsRefusesAnInputWithImages(t *testing.T) {
	image, _ := imageFile(t)
	session := start(t, func(profile *acp.Profile) { profile.Args = acp.StaticArgs(fixture, "no-images") })
	if session.Capabilities().Images {
		t.Fatal("no images advertised")
	}
	refused := prompt(t, session, "look", oar.InputOptions{Images: []oar.InputImage{{Path: image}}})
	if refused.Response.Response.Kind != oar.ResponseRejected || refused.Response.Response.Code != oar.CodeUnsupported {
		t.Fatalf("refused %+v", refused.Response.Response)
	}
	if kind := session.Status().Value.Kind; kind != "idle" {
		t.Fatal(kind)
	}
	queued := queue(t, session, "look", oar.InputOptions{Images: []oar.InputImage{{Path: image}}})
	if queued.Response.Response.Kind != oar.ResponseRejected || queued.Response.Response.Code != oar.CodeUnsupported {
		t.Fatalf("queued %+v", queued.Response.Response)
	}
}

func TestProfileCanSayAnAgentTakesImagesItsInitializeDoesNotAdvertise(t *testing.T) {
	image, href := imageFile(t)
	yes := true
	session := start(t, func(profile *acp.Profile) {
		profile.Args = acp.StaticArgs(fixture, "no-images")
		profile.Capabilities = acp.Capabilities{Attribution: "nested", Images: &yes}
	})
	if !session.Capabilities().Images {
		t.Fatal("the profile says images")
	}
	run := promptAndWait(t, session, "look", observe.PromptRunOptions{Images: []oar.InputImage{{Path: image}}})
	if run.Kind != "ended" || run.Text != "echo:[image image/png "+href+"] look" {
		t.Fatalf("run %+v", run)
	}
}

func TestImageOnlyInputHasNoTrailingEmptyTextBlock(t *testing.T) {
	image, href := imageFile(t)
	session := start(t, nil)
	run := promptAndWait(t, session, "", observe.PromptRunOptions{Images: []oar.InputImage{{Path: image}}})
	if run.Kind != "ended" || run.Text != "echo:[image image/png "+href+"]" {
		t.Fatalf("run %+v", run)
	}
}
