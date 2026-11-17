package attachment

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAttachmentStoreDiskDeduplicationAndHeaders(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	st, err := NewStore(Config{Dir: dir, MaxBytes: 1024})
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	pngBytes := []byte("\x89PNG\r\n\x1a\nfake-png-content")
	att1, err := st.CreateFromBase64(context.Background(), AttachmentUpload{
		Name: "photo.png",
		Type: "",
		Data: base64.StdEncoding.EncodeToString(pngBytes),
	})
	if err != nil {
		t.Fatalf("CreateFromBase64 png: %v", err)
	}
	if !IsValidSHA256(att1.ID) || att1.Type != "image/png" || att1.Size != int64(len(pngBytes)) {
		t.Fatalf("unexpected attachment: %+v", att1)
	}

	// Duplicate bytes deduplicate to the same ID.
	att2, err := st.PutBytes(context.Background(), "copy.png", "image/png", pngBytes)
	if err != nil || att2.ID != att1.ID {
		t.Fatalf("expected deduplicated ID %q, got err=%v att=%+v", att1.ID, err, att2)
	}

	// Reload from disk.
	reloaded, err := NewStore(Config{Dir: dir, MaxBytes: 1024})
	if err != nil {
		t.Fatalf("reload NewStore: %v", err)
	}
	got, err := reloaded.Get(context.Background(), att1.ID)
	if err != nil || got != att1 {
		t.Fatalf("reload Get failed: err=%v got=%+v", err, got)
	}

	// Non-PDF gets CSP: sandbox and immutable Cache-Control.
	req := httptest.NewRequest(http.MethodGet, PathPrefix+att1.ID, nil)
	rec := httptest.NewRecorder()
	reloaded.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for png, got %d", rec.Code)
	}
	if rec.Header().Get("Cache-Control") != ImmutableCacheControl {
		t.Fatalf("unexpected Cache-Control: %q", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("expected CSP sandbox for non-PDF, got %q", rec.Header().Get("Content-Security-Policy"))
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("expected nosniff header")
	}

	// PDF omits CSP sandbox and uses inline disposition.
	pdfBytes := []byte("%PDF-1.4\n%fake\n")
	pdfAtt, err := reloaded.PutBytes(context.Background(), "report.pdf", "application/pdf", pdfBytes)
	if err != nil {
		t.Fatalf("PutBytes pdf: %v", err)
	}
	pdfRec := httptest.NewRecorder()
	reloaded.ServeHTTP(pdfRec, httptest.NewRequest(http.MethodGet, PathPrefix+pdfAtt.ID, nil))
	if pdfRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for pdf, got %d", pdfRec.Code)
	}
	if csp := pdfRec.Header().Get("Content-Security-Policy"); csp != "" {
		t.Fatalf("expected no CSP sandbox for PDF, got %q", csp)
	}
	if !strings.HasPrefix(pdfRec.Header().Get("Content-Disposition"), "inline;") {
		t.Fatalf("expected inline disposition for PDF, got %q", pdfRec.Header().Get("Content-Disposition"))
	}

	// HTML attachment gets attachment disposition AND CSP sandbox.
	htmlAtt, err := reloaded.PutBytes(context.Background(), "note.html", "text/html", []byte("<script>alert(1)</script>"))
	if err != nil {
		t.Fatalf("PutBytes html: %v", err)
	}
	htmlRec := httptest.NewRecorder()
	reloaded.ServeHTTP(htmlRec, httptest.NewRequest(http.MethodGet, PathPrefix+htmlAtt.ID, nil))
	if htmlRec.Header().Get("Content-Security-Policy") != "sandbox" {
		t.Fatalf("expected CSP sandbox for html")
	}
	if !strings.HasPrefix(htmlRec.Header().Get("Content-Disposition"), "attachment;") {
		t.Fatalf("expected attachment disposition for html, got %q", htmlRec.Header().Get("Content-Disposition"))
	}

	// Uppercase SHA-256 is strictly rejected.
	upperReq := httptest.NewRequest(http.MethodGet, PathPrefix+strings.ToUpper(att1.ID), nil)
	upperRec := httptest.NewRecorder()
	reloaded.ServeHTTP(upperRec, upperReq)
	if upperRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for uppercase sha256, got %d", upperRec.Code)
	}
	if _, err := reloaded.Get(context.Background(), strings.ToUpper(att1.ID)); !errors.Is(err, ErrInvalidSHA256) {
		t.Fatalf("expected ErrInvalidSHA256, got %v", err)
	}

	// Corrupt blob on disk fails integrity check.
	if err := os.WriteFile(filepath.Join(dir, att1.ID), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := reloaded.Bytes(context.Background(), att1.ID); !errors.Is(err, ErrCorrupted) {
		t.Fatalf("expected ErrCorrupted on tampered blob, got %v", err)
	}
}

func TestAttachmentStoreValidationLimitsAndInMemory(t *testing.T) {
	t.Parallel()

	st, err := NewStore(Config{MaxBytes: 16})
	if err != nil {
		t.Fatalf("NewStore memory: %v", err)
	}

	if _, err := st.CreateFromBase64(context.Background(), AttachmentUpload{Name: "empty.txt", Type: "text/plain", Data: ""}); !errors.Is(err, ErrEmpty) {
		t.Fatalf("expected ErrEmpty, got %v", err)
	}
	if _, err := st.PutBytes(context.Background(), "big.bin", "application/octet-stream", make([]byte, 17)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
	if _, err := st.CreateFromBase64(context.Background(), AttachmentUpload{
		Name: "big.b64",
		Type: "text/plain",
		Data: base64.StdEncoding.EncodeToString(make([]byte, 17)),
	}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge from base64, got %v", err)
	}
	if _, err := st.CreateFromBase64(context.Background(), AttachmentUpload{Name: "bad", Data: "!!!not-base64!!!"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("expected ErrInvalidInput for invalid base64, got %v", err)
	}

	att, err := st.PutBytes(context.Background(), "hello.txt", "", []byte("hello world"))
	if err != nil {
		t.Fatalf("PutBytes memory: %v", err)
	}
	list, err := st.Of(context.Background(), []string{att.ID, att.ID})
	if err != nil || len(list) != 1 || list[0].ID != att.ID {
		t.Fatalf("Of failed: err=%v list=%+v", err, list)
	}
}
