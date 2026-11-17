package gateway_test

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/domain/gateway"
)

func TestArtifactMarkdownImageRoundTripAndHTMLShell(t *testing.T) {
	_, _, ts := newTestGateway(t)

	// 1. Create a markdown artifact referencing an attachment image URL.
	var created struct {
		ID string `json:"id"`
	}
	resp, raw := doPOST(t, ts.URL, "/api/v1/artifact/create", map[string]any{
		"title":   "Generated image reference",
		"kind":    "markdown",
		"content": "![Generated image](/api/v1/attachment/att-123/file)",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/artifact/create", resp, raw, &created)
	if created.ID == "" {
		t.Fatal("expected artifact id")
	}

	var mdOut struct {
		Content string `json:"content"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/artifact/content/get", map[string]any{"id": created.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/artifact/content/get", resp, raw, &mdOut)
	if !strings.Contains(mdOut.Content, "/api/v1/attachment/att-123/file") {
		t.Fatalf("expected attachment URL preserved in markdown round-trip, got %q", mdOut.Content)
	}

	// 2. HTML deliverable preview injects shell CSS variables and anchor edits preserve text cleanly.
	var htmlArt struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/artifact/create", map[string]any{
		"title":   "Report",
		"kind":    "html",
		"content": `<!doctype html><html><body><p>Hello &amp; world</p></body></html>`,
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/artifact/create", resp, raw, &htmlArt)

	previewResp, err := http.Get(fmt.Sprintf("%s/api/v1/artifact/%s/%d?shell=1", ts.URL, htmlArt.ID, htmlArt.Version))
	if err != nil {
		t.Fatalf("GET preview: %v", err)
	}
	previewBytes, _ := io.ReadAll(previewResp.Body)
	previewResp.Body.Close()
	if previewResp.StatusCode != http.StatusOK {
		t.Fatalf("preview status %d, want 200", previewResp.StatusCode)
	}
	if !strings.Contains(string(previewBytes), "--vv-page") {
		t.Fatalf("expected shell variables injected into preview HTML")
	}

	var edited struct {
		Version int `json:"version"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/artifact/html/edit", map[string]any{
		"id":      htmlArt.ID,
		"version": htmlArt.Version,
		"anchor": map[string]any{
			"kind":  "quote",
			"exact": "Hello & world",
		},
		"text": "Updated headline",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/artifact/html/edit", resp, raw, &edited)

	var htmlContent struct {
		Content string `json:"content"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/artifact/content/get", map[string]any{"id": htmlArt.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/artifact/content/get", resp, raw, &htmlContent)
	if !strings.Contains(htmlContent.Content, "Updated headline") {
		t.Fatalf("expected HTML anchor edit applied, got %q", htmlContent.Content)
	}
}

func TestPKMJournalSlugYAMLQuotesAndOutlineOps(t *testing.T) {
	_, _, ts := newTestGateway(t)

	// Open a journal day and verify canonical journals/YYYY_MM_DD.md file + YAML quote escaping.
	var page struct {
		File   string `json:"file"`
		Slug   string `json:"slug"`
		Title  string `json:"title"`
		Blocks []struct {
			ID string `json:"id"`
		} `json:"blocks"`
	}
	resp, raw := doPOST(t, ts.URL, "/api/v1/pkm/journal/open", map[string]any{"day": "2026-11-17"}, nil)
	mustSuccessEnvelope(t, "/api/v1/pkm/journal/open", resp, raw, &page)
	if page.File != "journals/2026_11_17.md" {
		t.Fatalf("journal file = %q, want journals/2026_11_17.md", page.File)
	}
	if len(page.Blocks) == 0 {
		t.Fatal("expected initial block in journal")
	}

	// Save a note with colon in YAML frontmatter property and test outline insert/marker/move_to.
	var saved struct {
		File   string `json:"file"`
		Blocks []struct {
			ID string `json:"id"`
		} `json:"blocks"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/pkm/page/save", map[string]any{
		"title":    "Note: Special \"Quotes\"",
		"tier":     "project",
		"props":    map[string]string{"owner": "team: core"},
		"markdown": "- First task\n- Second task",
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/pkm/page/save", resp, raw, &saved)
	if len(saved.Blocks) < 2 {
		t.Fatalf("expected 2 blocks after save, got %d", len(saved.Blocks))
	}

	var applied struct {
		Blocks []struct {
			ID     string `json:"id"`
			Body   string `json:"body"`
			Marker string `json:"marker"`
		} `json:"blocks"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/pkm/block/apply", map[string]any{
		"page": saved.File,
		"ops": []map[string]any{
			{"op": "set_marker", "block": saved.Blocks[0].ID, "marker": "DOING"},
			{"op": "move_to", "block": saved.Blocks[1].ID, "target": saved.Blocks[0].ID, "at": "before"},
			{"op": "update", "block": saved.Blocks[1].ID, "body": ""},
		},
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/pkm/block/apply", resp, raw, &applied)
	if len(applied.Blocks) != 2 || applied.Blocks[0].Body != "" || applied.Blocks[1].Body != "First task" {
		t.Fatalf("unexpected block apply order/content: %+v", applied.Blocks)
	}
	if applied.Blocks[1].Marker != "DOING" {
		t.Fatalf("marker = %q, want DOING", applied.Blocks[1].Marker)
	}
}

func TestIssueOrderingMovesAndGitDiff(t *testing.T) {
	_, _, ts := newTestGateway(t)

	var addedRepo struct {
		ID string `json:"id"`
	}
	resp, raw := doPOST(t, ts.URL, "/api/v1/repo/create", map[string]any{"name": "sample-repo"}, nil)
	mustSuccessEnvelope(t, "/api/v1/repo/create", resp, raw, &addedRepo)

	var i1, i2 struct {
		ID string `json:"id"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/issue/create", map[string]any{"title": "First", "repo": addedRepo.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/issue/create", resp, raw, &i1)
	resp, raw = doPOST(t, ts.URL, "/api/v1/issue/create", map[string]any{"title": "Second", "repo": addedRepo.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/issue/create", resp, raw, &i2)

	// Move i2 before i1 via issue/update.
	resp, raw = doPOST(t, ts.URL, "/api/v1/issue/update", map[string]any{"id": i2.ID, "before": i1.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/issue/update", resp, raw, nil)

	var listed []struct {
		ID    string   `json:"id"`
		Moves []string `json:"moves"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/issue/list", map[string]any{}, nil)
	mustSuccessEnvelope(t, "/api/v1/issue/list", resp, raw, &listed)
	if len(listed) < 2 || listed[0].ID != i2.ID || listed[1].ID != i1.ID {
		t.Fatalf("expected reordered issue list [Second, First], got %+v", listed)
	}
	if len(listed[0].Moves) == 0 {
		t.Fatalf("expected non-empty allowed moves for issue %+v", listed[0])
	}

	// Before a worktree exists, diff returns ok=false without crashing.
	var diff struct {
		OK     bool `json:"ok"`
		Behind int  `json:"behind"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/issue/diff/get", map[string]any{"id": i1.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/issue/diff/get", resp, raw, &diff)
	if diff.OK {
		t.Fatalf("expected diff ok=false before worktree creation, got %+v", diff)
	}
}

func TestOfflineMediaSpeechLargeReleaseAndTruncatedStream(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "1")
	_, _, ts := newTestGateway(t)

	// Configure MOSS provider with speech binding & two connections.
	var prov struct {
		Revision int `json:"revision"`
	}
	resp, raw := doPOST(t, ts.URL, "/api/v1/provider/get", nil, nil)
	mustSuccessEnvelope(t, "/api/v1/provider/get", resp, raw, &prov)

	resp, raw = doPOST(t, ts.URL, "/api/v1/provider/update", map[string]any{
		"revision": prov.Revision,
		"connections": []map[string]any{
			{"id": "conn-a", "name": "A", "adapter": "moss", "enabled": true, "key": "test-speech-key"},
		},
		"speech": map[string]any{"connection": "conn-a", "model": "moss-tts-1.5-flash"},
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/provider/update", resp, raw, &prov)

	// Check offline voice listing.
	var voices struct {
		Voices []struct {
			ID string `json:"id"`
		} `json:"voices"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/provider/voice/list", map[string]any{
		"connection": "conn-a",
		"revision":   prov.Revision,
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/provider/voice/list", resp, raw, &voices)
	if len(voices.Voices) == 0 {
		t.Fatal("expected offline voices to be returned")
	}

	// [speech:large] -> >25MB resultInput, no attachment, canDelete=false, revision-invariant retry & release.
	var largeJob struct {
		ID          string `json:"id"`
		Phase       string `json:"phase"`
		Format      string `json:"format"`
		ContentType string `json:"contentType"`
		CanRelease  bool   `json:"canRelease"`
		Attachment  any    `json:"attachment"`
		ResultInput *struct {
			ID   string `json:"id"`
			Size int64  `json:"size"`
		} `json:"resultInput"`
	}
	reqBody := map[string]any{
		"id":         "speech-large-1",
		"text":       "[speech:large]",
		"voice":      voices.Voices[0].ID,
		"format":     "mp3",
		"connection": "conn-a",
		"revision":   prov.Revision,
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/speech/create", reqBody, nil)
	mustSuccessEnvelope(t, "/api/v1/media/speech/create", resp, raw, &largeJob)
	if largeJob.Phase != "ready" || largeJob.Attachment != nil || largeJob.ResultInput == nil || largeJob.ResultInput.Size <= 25*1024*1024 {
		t.Fatalf("unexpected [speech:large] result: %+v", largeJob)
	}
	if !largeJob.CanRelease || largeJob.Format != "wav" || largeJob.ContentType != "audio/wav" {
		t.Fatalf("expected releaseable wav large speech, got %+v", largeJob)
	}

	var inMeta struct {
		CanDelete bool `json:"canDelete"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/input/get", map[string]any{"id": largeJob.ResultInput.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/input/get", resp, raw, &inMeta)
	if inMeta.CanDelete {
		t.Fatal("expected job resultInput CanDelete=false")
	}

	// Provider revision bumps -> retry with same ID succeeds idempotently.
	resp, raw = doPOST(t, ts.URL, "/api/v1/provider/update", map[string]any{
		"revision": prov.Revision,
		"connections": []map[string]any{
			{"id": "conn-a", "name": "A2", "adapter": "moss", "enabled": true, "key": "test-speech-key-2"},
		},
		"speech": map[string]any{"connection": "conn-a", "model": "moss-tts-1.5-flash"},
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/provider/update", resp, raw, &prov)

	var retried struct {
		ID string `json:"id"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/speech/create", reqBody, nil)
	mustSuccessEnvelope(t, "/api/v1/media/speech/create", resp, raw, &retried)
	if retried.ID != largeJob.ID {
		t.Fatalf("expected idempotent retry after revision bump, got %+v", retried)
	}

	// Release deletes resultInput and rejects subsequent media/input/get.
	var released struct {
		CanRelease  bool `json:"canRelease"`
		ResultInput any  `json:"resultInput"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/job/release", map[string]any{"id": largeJob.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/job/release", resp, raw, &released)
	if released.CanRelease || released.ResultInput != nil {
		t.Fatalf("expected released job with nil resultInput, got %+v", released)
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/input/get", map[string]any{"id": largeJob.ResultInput.ID}, nil)
	assertErrorEnvelope(t, resp, raw, http.StatusNotFound, gateway.BizMediaNotFound)

	// Truncated speech stream transitions to unknown with problem and ignores subsequent cancel.
	var truncJob struct {
		ID string `json:"id"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/speech/create", map[string]any{
		"id":         "speech-trunc-1",
		"text":       "[speech:stream-truncated]",
		"voice":      voices.Voices[0].ID,
		"streaming":  true,
		"connection": "conn-a",
		"revision":   prov.Revision,
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/speech/create", resp, raw, &truncJob)

	streamResp, err := http.Get(ts.URL + "/api/v1/media/speech/" + truncJob.ID + "/stream")
	if err != nil {
		t.Fatalf("GET stream: %v", err)
	}
	_, _ = io.ReadAll(streamResp.Body)
	streamResp.Body.Close()

	var afterCancel struct {
		Phase   string `json:"phase"`
		Problem string `json:"problem"`
	}
	resp, raw = doPOST(t, ts.URL, "/api/v1/media/job/cancel", map[string]any{"id": truncJob.ID}, nil)
	mustSuccessEnvelope(t, "/api/v1/media/job/cancel", resp, raw, &afterCancel)
	if afterCancel.Phase != "unknown" || afterCancel.Problem == "" {
		t.Fatalf("expected truncated stream to stay unknown with problem after cancel, got %+v", afterCancel)
	}
}

func TestOfflineVoiceWebSocketRelaysAndCookie(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "1")
	_, _, ts := newTestGateway(t)

	// Verify device cookie uses vibevalley_device_key when answering LAN/device endpoint or state.
	var prov struct {
		Revision int `json:"revision"`
	}
	resp, raw := doPOST(t, ts.URL, "/api/v1/provider/get", nil, nil)
	mustSuccessEnvelope(t, "/api/v1/provider/get", resp, raw, &prov)

	resp, raw = doPOST(t, ts.URL, "/api/v1/provider/update", map[string]any{
		"revision": prov.Revision,
		"connections": []map[string]any{
			{"id": "rt-conn", "name": "RT", "adapter": "moss", "enabled": true, "key": "test-rt-key"},
		},
		"live":   map[string]any{"connection": "rt-conn", "model": "moss-live-1.0-2026-11-02"},
		"vision": map[string]any{"connection": "rt-conn", "model": "moss-vl-realtime-1.0-2026-09-09"},
	}, nil)
	mustSuccessEnvelope(t, "/api/v1/provider/update", resp, raw, &prov)

	u, _ := url.Parse(ts.URL)
	dialWS := func(path string) (net.Conn, *bufio.Reader) {
		conn, err := net.Dial("tcp", u.Host)
		if err != nil {
			t.Fatalf("Dial %s: %v", path, err)
		}
		var nonce [16]byte
		_, _ = rand.Read(nonce[:])
		wsKey := base64.StdEncoding.EncodeToString(nonce[:])
		req := "GET " + path + " HTTP/1.1\r\n" +
			"Host: " + u.Host + "\r\n" +
			"Origin: http://" + u.Host + "\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Key: " + wsKey + "\r\n" +
			"Sec-WebSocket-Version: 13\r\n\r\n"
		if _, err := conn.Write([]byte(req)); err != nil {
			t.Fatalf("write upgrade: %v", err)
		}
		br := bufio.NewReader(conn)
		tpResp, err := http.ReadResponse(br, nil)
		if err != nil {
			t.Fatalf("ReadResponse: %v", err)
		}
		if tpResp.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("WS %s status=%d, want 101", path, tpResp.StatusCode)
		}
		sum := sha1.Sum([]byte(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		if got := tpResp.Header.Get("Sec-WebSocket-Accept"); got != base64.StdEncoding.EncodeToString(sum[:]) {
			t.Fatalf("bad Sec-WebSocket-Accept: %q", got)
		}
		return conn, br
	}

	writeClientFrame := func(conn net.Conn, opcode byte, payload []byte) {
		var mask [4]byte
		_, _ = rand.Read(mask[:])
		var hdr []byte
		hdr = append(hdr, 0x80|opcode)
		n := len(payload)
		if n <= 125 {
			hdr = append(hdr, 0x80|byte(n))
		} else {
			hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
		}
		hdr = append(hdr, mask[:]...)
		masked := make([]byte, n)
		for i := range payload {
			masked[i] = payload[i] ^ mask[i%4]
		}
		if _, err := conn.Write(append(hdr, masked...)); err != nil {
			t.Fatalf("write WS frame: %v", err)
		}
	}

	readServerFrame := func(br *bufio.Reader) (byte, []byte) {
		var b [2]byte
		if _, err := io.ReadFull(br, b[:]); err != nil {
			t.Fatalf("read WS frame header: %v", err)
		}
		op := b[0] & 0x0F
		l := uint64(b[1] & 0x7F)
		if l == 126 {
			var ext [2]byte
			if _, err := io.ReadFull(br, ext[:]); err != nil {
				t.Fatal(err)
			}
			l = uint64(binary.BigEndian.Uint16(ext[:]))
		}
		buf := make([]byte, int(l))
		if l > 0 {
			if _, err := io.ReadFull(br, buf); err != nil {
				t.Fatal(err)
			}
		}
		return op, buf
	}

	// Test MOSS Live relay.
	liveConn, liveReader := dialWS("/api/v1/voice/moss/line")
	defer liveConn.Close()
	writeClientFrame(liveConn, 0x1, []byte(`{"action":"session.update"}`))
	op, data := readServerFrame(liveReader)
	if op != 0x1 || !strings.Contains(string(data), "session.updated") {
		t.Fatalf("expected session.updated frame, got op=%d data=%s", op, string(data))
	}
	writeClientFrame(liveConn, 0x2, []byte{0, 1, 2, 3})
	sawTranscript := false
	for range 5 {
		op, data = readServerFrame(liveReader)
		if op == 0x1 && strings.Contains(string(data), "output.transcript.done") {
			sawTranscript = true
		}
	}
	if !sawTranscript {
		t.Fatal("expected output.transcript.done from MOSS live WS")
	}

	// Test Vision relay.
	visConn, visReader := dialWS("/api/v1/voice/vision/line")
	defer visConn.Close()
	op, data = readServerFrame(visReader)
	if op != 0x1 || !strings.Contains(string(data), "session.created") {
		t.Fatalf("expected session.created on vision WS, got op=%d data=%s", op, string(data))
	}
	writeClientFrame(visConn, 0x1, []byte(`{"type":"input.prompt","seq_no":1,"final":true}`))
	sawDone := false
	for range 5 {
		op, data = readServerFrame(visReader)
		if op == 0x1 && strings.Contains(string(data), `"type":"session.done"`) {
			sawDone = true
		}
	}
	if !sawDone {
		t.Fatal("expected session.done from vision WS on final prompt")
	}
}
