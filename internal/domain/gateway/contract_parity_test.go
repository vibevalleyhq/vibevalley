package gateway_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			if _, pErr := os.Stat(filepath.Join(dir, "packages", "protocol", "src", "client.ts")); pErr == nil {
				return dir
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not locate repo root with go.mod and packages/protocol")
		}
		dir = parent
	}
}

func isolatedSubprocessEnv(vibeHome string) []string {
	out := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "VIBEVALLEY_HOME=") ||
			strings.HasPrefix(entry, "VIBE_CONFIG=") ||
			strings.HasPrefix(entry, "VIBE_DB_PATH=") ||
			strings.HasPrefix(entry, "VIBE_WORK_ROOT=") ||
			strings.HasPrefix(entry, "VIBE_WEB_DIST=") {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "VIBEVALLEY_HOME="+vibeHome)
}

func TestRealVibeValleyProtocolZodContractParity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	repoRoot := findRepoRoot(t)
	vpxPath, err := exec.LookPath("vpx")
	if err != nil {
		t.Fatalf("vpx binary required for real Zod contract parity test: %v", err)
	}

	tmp := t.TempDir()
	binName := "vibe-server"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	serverBin := filepath.Join(tmp, binName)
	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	buildCmd := exec.CommandContext(ctx, goBin, "build", "-o", serverBin, "./cmd/vibe-server")
	buildCmd.Dir = repoRoot
	buildCmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOROOT="+runtime.GOROOT())
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("build ./cmd/vibe-server: %v\n%s", err, string(out))
	}

	// Create temp SPA dist and a temp git repo so repo.create succeeds offline.
	webDist := filepath.Join(tmp, "web-dist")
	if err := os.MkdirAll(webDist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webDist, "index.html"), []byte("<!doctype html><html><body>VibeValley</body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}

	gitRepoDir := filepath.Join(tmp, "sample-repo")
	if err := os.MkdirAll(gitRepoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, gitArgs := range [][]string{
		{"init", "-b", "main"},
		{"config", "user.email", "parity@example.com"},
		{"config", "user.name", "Parity Tester"},
	} {
		gCmd := exec.CommandContext(ctx, "git", gitArgs...)
		gCmd.Dir = gitRepoDir
		if out, err := gCmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", gitArgs, err, string(out))
		}
	}
	if err := os.WriteFile(filepath.Join(gitRepoDir, "README.md"), []byte("# Sample Repo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, gitArgs := range [][]string{
		{"add", "README.md"},
		{"commit", "-m", "initial commit"},
	} {
		gCmd := exec.CommandContext(ctx, "git", gitArgs...)
		gCmd.Dir = gitRepoDir
		if out, err := gCmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", gitArgs, err, string(out))
		}
	}

	vibeHome := filepath.Join(tmp, "vibe-home")
	srvCmd := exec.CommandContext(ctx, serverBin,
		"--addr", "127.0.0.1:0",
		"--preview-addr", "127.0.0.1:0",
		"--db", filepath.Join(tmp, "parity.db"),
		"--work-root", filepath.Join(tmp, "work"),
		"--web", webDist,
		"--ready-json",
	)
	srvCmd.Env = isolatedSubprocessEnv(vibeHome)
	stdout, err := srvCmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var srvErr bytes.Buffer
	srvCmd.Stderr = &srvErr
	if err := srvCmd.Start(); err != nil {
		t.Fatalf("start vibe-server: %v", err)
	}
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- srvCmd.Wait()
	}()
	defer func() {
		if srvCmd.Process != nil {
			_ = srvCmd.Process.Kill()
		}
		<-waitDone
	}()

	readyCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		if sc.Scan() {
			readyCh <- sc.Text()
		}
	}()

	var ready struct {
		PID int    `json:"pid"`
		URL string `json:"url"`
	}
	select {
	case line := <-readyCh:
		if err := json.Unmarshal([]byte(line), &ready); err != nil {
			t.Fatalf("decode ready-json %q: %v", line, err)
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for --ready-json: %s", srvErr.String())
	}
	if ready.PID <= 0 || ready.URL == "" {
		t.Fatalf("expected valid pid and url in ready-json, got %+v", ready)
	}

	// Write parity verification TS script into t.TempDir() (never repo root!).
	scriptPath := filepath.Join(tmp, "zod-parity.ts")
	clientImport := filepath.Join(repoRoot, "packages", "protocol", "src", "client.ts")
	schemaImport := filepath.Join(repoRoot, "packages", "protocol", "src", "schema.ts")
	rpcImport := filepath.Join(repoRoot, "packages", "protocol", "src", "rpc.ts")

	tsSource := fmt.Sprintf(`
import { VibeValleyApi } from %q;
import * as S from %q;
import { subscriptions, subscriptionUrl } from %q;

const baseURL = process.env.PARITY_BASE_URL!;
const sampleRepo = process.env.PARITY_REPO_DIR!;
const api = new VibeValleyApi(baseURL);

async function readFirstSSEData(url: string, predicate?: (raw: string) => boolean): Promise<unknown> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error("SSE HTTP " + res.status + " on " + url);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const raw = line.slice(6).trim();
          if (!predicate || predicate(raw)) {
            return JSON.parse(raw);
          }
        }
      }
    }
  } finally {
    controller.abort();
  }
  throw new Error("SSE stream closed without matching data from " + url);
}

async function run() {
  // 1. Validate empty/initial StateFrame SSE with S.StateFrame.parse.
  const initialFrame = await readFirstSSEData(baseURL + "/api/v1/state");
  S.StateFrame.parse(initialFrame);

  // 2. Platform endpoints (setting, provider, user, lan, voice, connectors, runtime, game).
  await api.server.health.get();
  await api.setting.get();
  await api.setting.validate({ locale: "en" });
  await api.setting.update({
    locale: "en",
    agoraAppId: "0123456789abcdef0123456789abcdef",
    agoraAppCertificate: "fedcba9876543210fedcba9876543210",
  });
  await api.provider.get();
  await api.user.get();
  await api.user.device.list();
  await api.user.approval.list();
  await api.connector.list();
  await api.runtime.list();
  await api.game.achievement.list();
  await api.github.get();
  await api.lan.get();
  const grant = await api.voice.grant.create();
  if (!grant.appId || !grant.token) {
    throw new Error("expected AgoraGrant from voice.grant.create");
  }

  // 3. Repo & Agent & Skill endpoints.
  const repo = await api.repo.create({ name: "sample-repo" });
  await api.repo.list();
  await api.repo.language.list({ id: repo.name });
  await api.repo.template.list({ id: repo.name });
  await api.repo.activity.get({ id: repo.name });

  const templates = await api.agent.template.list();
  const agents = await api.agent.list();
  const customAgent = await api.agent.create({
    id: "parity-worker",
    role: "worker",
    name: "Parity Worker",
    duty: "Verify contracts",
    tags: ["parity"],
    runtime: "claude",
    model: "",
    effort: "medium",
    personaMode: "append",
    worktree: true,
    look: {
      species: "fox",
      fur: "#d97757",
      shirt: "#2f6b56",
      hat: "straw",
      glasses: "none",
      outfit: null,
      orchestrator: null,
    },
    persona: "Check every schema",
    source: "user",
    skills: [],
  });
  await api.agent.list();
  const skills = await api.skill.list();
  await api.skill.create({
    id: "parity-skill",
    name: "Parity Skill",
    summary: "Schema check",
    when: "Testing",
    body: "Verify Zod parity.",
    source: "user",
  });

  // 4. Issue & Cron endpoints.
  const applied = await api.issue.create({
    title: "Zod Parity Issue",
    description: "Ensure every field parses cleanly",
    repo: repo.name,
    agent: customAgent.id,
    criteria: ["all fields match"],
  });
  await api.issue.list({});
  await api.issue.get({ id: applied.id });
  await api.issue.update({ id: applied.id, priority: "high" });
  await api.issue.timeline.get({ id: applied.id });
  await api.issue.run.list({ id: applied.id });
  await api.issue.history.list();
  await api.issue.diff.get({ id: applied.id });
  await api.issue.status.previewUpdate({ id: applied.id, status: "done" });

  await api.cron.create({
    name: "Parity Cron",
    text: "Daily parity check",
    when: { kind: "cron", expr: "0 9 * * *" },
    agent: customAgent.id,
    repo: repo.name,
  });
  await api.cron.list();

  // 5. Channel & Messages & channel.follow SSE subscription.
  await api.channel.list();
  const chId = await api.channel.create({ type: "public", name: "zod-room" });
  await api.channel.message.send({ id: chId, text: "hello @parity-worker" });
  const msgs = await api.channel.message.list({ id: chId });
  if (msgs.length === 0) throw new Error("expected sent channel message");
  await api.channel.unread.list();

  const chFollowUrl = baseURL + subscriptionUrl("channel.follow", { id: chId, after: 0 });
  const chEv = await readFirstSSEData(chFollowUrl);
  subscriptions["channel.follow"].event.parse(chEv);

  // 6. PKM endpoints.
  const savedPage = await api.pkm.page.save({ title: "Parity Page", markdown: "- first item", tier: "project" });
  await api.pkm.page.list();
  await api.pkm.page.get({ page: savedPage.slug });
  await api.pkm.journal.open({ day: "2026-11-17" });
  await api.pkm.radar.get({});

  // 7. Artifact & Blocks & Suggestions & artifact.follow SSE subscription.
  const blkArt = await api.artifact.create({
    title: "Parity Blocks",
    kind: "markdown",
    content: "# Hello\n\nWorld",
    channel: chId,
    issue: applied.id,
  });
  const snap = await api.artifact.block.list({ id: blkArt.id });
  await api.artifact.markdown.get({ id: blkArt.id });
  const firstBlk = snap.blocks[0];
  if (firstBlk) {
    await api.artifact.suggestion.create({
      id: blkArt.id,
      block: firstBlk.id,
      baseRev: firstBlk.rev,
      change: { text: [{ t: "Updated World", marks: {} }] },
    });
  }
  await api.artifact.suggestion.list({ id: blkArt.id });

  const artFollowUrl = baseURL + subscriptionUrl("artifact.follow", { id: blkArt.id, after: 0 });
  const artEv = await readFirstSSEData(artFollowUrl);
  subscriptions["artifact.follow"].event.parse(artEv);

  const sgFollowUrl = baseURL + subscriptionUrl("artifact.suggestion.follow", { id: blkArt.id });
  const sgEv = await readFirstSSEData(sgFollowUrl);
  subscriptions["artifact.suggestion.follow"].event.parse(sgEv);

  const htmlArt = await api.artifact.create({
    title: "Parity HTML",
    kind: "html",
    display: "page",
    content: "<!doctype html><html><body>Parity</body></html>",
    channel: chId,
  });
  await api.artifact.list({});
  await api.artifact.content.get({ id: htmlArt.id });

  await api.orchestrator.open();
  await api.session.list({});
  await api.memory.create({ agent: customAgent.id, text: "Remember parity checks", repo: repo.name });
  await api.memory.list({ agent: customAgent.id });
  await api.memory.search({ text: "parity" });
  await api.issue.comment.create({ id: applied.id, text: "Looks good" });
  await api.issue.review({ id: applied.id, pass: true, findings: ["clean"] });
  await api.issue.status.update({ id: applied.id, status: "done" });

  // 8. Attachment, Library & Media endpoints.
  const att = await api.attachment.create({
    name: "hello.txt",
    type: "text/plain",
    data: Buffer.from("hello parity").toString("base64"),
  });
  await api.media.input.create({ kind: "audio", name: "voice.wav", mime: "audio/wav", size: 8 });
  await api.media.input.list();
  await api.media.job.list();
  await api.library.item.list({});

  // 9. Validate POPULATED StateFrame & /api/v1/events ServerEvent after all mutations!
  const populatedFrame = await readFirstSSEData(baseURL + "/api/v1/state");
  const parsedFrame = S.StateFrame.parse(populatedFrame);
  const evSnap = await readFirstSSEData(baseURL + "/api/v1/events");
  S.ServerEvent.parse(evSnap);

  const finalAgents = await api.agent.list();
  const finalRepos = await api.repo.list();

  console.log(JSON.stringify({
    ok: true,
    templates: templates.length,
    agents: finalAgents.length,
    skills: skills.length,
    repos: finalRepos.length,
    issues: parsedFrame.state.issues.length,
    channels: parsedFrame.state.chat?.channels.length ?? 0,
    attachmentId: att.id,
  }));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
`, clientImport, schemaImport, rpcImport)

	if err := os.WriteFile(scriptPath, []byte(tsSource), 0o600); err != nil {
		t.Fatal(err)
	}

	vpxCmd := exec.CommandContext(ctx, vpxPath, scriptPath)
	vpxCmd.Dir = repoRoot
	vpxCmd.Env = append(os.Environ(),
		"PARITY_BASE_URL="+ready.URL,
		"PARITY_REPO_DIR="+gitRepoDir,
	)
	out, runErr := vpxCmd.CombinedOutput()
	if runErr != nil {
		t.Fatalf("real Zod contract parity script failed: %v\nOutput:\n%s\nServer stderr:\n%s", runErr, string(out), srvErr.String())
	}
	if !strings.Contains(string(out), `"ok":true`) {
		t.Fatalf("unexpected parity output:\n%s", string(out))
	}
}
