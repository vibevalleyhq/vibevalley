package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/setting"
)

func offlineMediaEnabled() bool {
	return os.Getenv("VIBEVALLEY_TEST_RUNTIMES") == "1"
}

func generateOfflinePNG(width, height int) ([]byte, error) {
	if width <= 0 {
		width = 256
	}
	if height <= 0 {
		height = 256
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	c := color.RGBA{R: 112, G: 168, B: 118, A: 255}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func generateOfflineWAV(samples int, sampleRate int) []byte {
	if sampleRate <= 0 {
		sampleRate = 24000
	}
	if samples <= 0 {
		samples = sampleRate / 4
	}
	dataSize := samples * 2
	out := make([]byte, 44+dataSize)
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+dataSize))
	copy(out[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	binary.LittleEndian.PutUint16(out[20:22], 1)
	binary.LittleEndian.PutUint16(out[22:24], 1)
	binary.LittleEndian.PutUint32(out[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(out[28:32], uint32(sampleRate*2))
	binary.LittleEndian.PutUint16(out[32:34], 2)
	binary.LittleEndian.PutUint16(out[34:36], 16)
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(dataSize))
	period := sampleRate
	if samples < period {
		period = samples
	}
	for i := 0; i < period; i++ {
		val := int16(math.Round(math.Sin(float64(i)*math.Pi*440.0/float64(sampleRate)) * 4000))
		binary.LittleEndian.PutUint16(out[44+i*2:46+i*2], uint16(val))
	}
	periodBytes := period * 2
	for off := 44 + periodBytes; off < len(out); off += periodBytes {
		copy(out[off:], out[44:44+periodBytes])
	}
	return out
}

func generateOfflineStereoWAV(frames int, sampleRate int) []byte {
	if sampleRate <= 0 {
		sampleRate = 24000
	}
	if frames <= 0 {
		frames = sampleRate / 4
	}
	dataSize := frames * 4
	out := make([]byte, 44+dataSize)
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+dataSize))
	copy(out[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	binary.LittleEndian.PutUint16(out[20:22], 1)
	binary.LittleEndian.PutUint16(out[22:24], 2)
	binary.LittleEndian.PutUint32(out[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(out[28:32], uint32(sampleRate*4))
	binary.LittleEndian.PutUint16(out[32:34], 4)
	binary.LittleEndian.PutUint16(out[34:36], 16)
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(dataSize))
	period := sampleRate
	if frames < period {
		period = frames
	}
	for i := 0; i < period; i++ {
		val := int16(math.Round(math.Sin(float64(i)*math.Pi*440.0/float64(sampleRate)) * 4000))
		binary.LittleEndian.PutUint16(out[44+i*4:46+i*4], uint16(val))
		binary.LittleEndian.PutUint16(out[46+i*4:48+i*4], uint16(-val))
	}
	periodBytes := period * 4
	for off := 44 + periodBytes; off < len(out); off += periodBytes {
		copy(out[off:], out[44:44+periodBytes])
	}
	return out
}

func generateOfflineMP3Frames() []byte {
	// 4 valid MPEG-1 Layer 3 silent frames (44.1kHz, 128kbps, 417 bytes/frame, ~104ms)
	// so Chromium audio elements report duration > 0 and readyState >= 2.
	const frameSize = 417
	const frameCount = 4
	out := make([]byte, frameSize*frameCount)
	for f := 0; f < frameCount; f++ {
		off := f * frameSize
		out[off+0] = 0xFF
		out[off+1] = 0xFB
		out[off+2] = 0x90
		out[off+3] = 0x00
	}
	return out
}

func stereoPCMChunkBase64() string {
	wavBytes := generateOfflineWAV(2400, 24000)
	mono := wavBytes[44:]
	samples := len(mono) / 2
	stereo := make([]byte, samples*4)
	for i := 0; i < samples; i++ {
		s := int16(binary.LittleEndian.Uint16(mono[i*2 : i*2+2]))
		binary.LittleEndian.PutUint16(stereo[i*4:i*4+2], uint16(s))
		binary.LittleEndian.PutUint16(stereo[i*4+2:i*4+4], uint16(-s))
	}
	return base64.StdEncoding.EncodeToString(stereo)
}

func (h *Handler) checkMossBinding(use string, connOverride string, revOverride *int) (string, string, int, *setting.ProviderConnection, error) {
	if h.st == nil || h.st.Setting == nil {
		return "", "", 0, nil, newBizError(BizServiceUnavailable, "setting service unavailable")
	}
	st := h.st.Setting.ProviderStatus()
	if revOverride != nil && *revOverride != st.Revision {
		return "", "", st.Revision, nil, newBizError(BizMediaRefused, "provider settings revision changed")
	}
	var connID, modelID string
	var b *setting.ProviderBinding
	switch use {
	case "image":
		b = st.Image
	case "understanding":
		b = st.Understanding
	case "speech":
		b = st.Speech
	case "speakers":
		b = st.Speakers
	case "voiceDesign":
		b = st.VoiceDesign
	case "transcription":
		b = st.Transcription
	case "clone":
		connID = connOverride
		if connID == "" && len(st.Connections) > 0 {
			connID = st.Connections[0].ID
		}
		if connID == "" {
			return "", "", st.Revision, nil, newBizError(BizMediaRefused, "connection is required")
		}
		for i := range st.Connections {
			if st.Connections[i].ID == connID && st.Connections[i].Enabled && st.Connections[i].Key.Source != nil {
				cp := st.Connections[i]
				return connID, "moss-tts-clone", st.Revision, &cp, nil
			}
		}
		return "", "", st.Revision, nil, newBizError(BizMediaRefused, fmt.Sprintf("connection %q is not configured", connID))
	}
	if b == nil {
		return "", "", st.Revision, nil, newBizError(BizMediaRefused, fmt.Sprintf("no %s model bound", use))
	}
	connID = firstNonEmpty(connOverride, b.Connection)
	modelID = b.Model
	if connOverride != "" && connOverride != b.Connection {
		return "", "", st.Revision, nil, newBizError(BizMediaRefused, "provider connection does not match current binding")
	}
	for i := range st.Connections {
		if st.Connections[i].ID == connID && st.Connections[i].Enabled && st.Connections[i].Key.Source != nil {
			cp := st.Connections[i]
			return connID, modelID, st.Revision, &cp, nil
		}
	}
	return "", "", st.Revision, nil, newBizError(BizMediaRefused, fmt.Sprintf("connection %q is not configured", connID))
}

func (h *Handler) addGeneratedLibraryItem(ctx context.Context, attID, jobID, jobKind string) {
	if h.st == nil || h.st.Attachments == nil {
		return
	}
	att, err := h.st.Attachments.Get(ctx, attID)
	if err != nil {
		return
	}
	now := h.hub.nowMs()
	item := ProtoLibraryItem{
		Attachment: att,
		Origin: map[string]any{
			"kind":    "generated",
			"job":     jobID,
			"jobKind": jobKind,
		},
		AddedAt: now,
		LastAt:  now,
	}
	h.hub.mu.Lock()
	replaced := false
	for i := range h.hub.state.Library {
		if h.hub.state.Library[i].Attachment.ID == att.ID {
			h.hub.state.Library[i].LastAt = now
			replaced = true
			break
		}
	}
	if !replaced {
		h.hub.state.Library = append(h.hub.state.Library, item)
	}
	h.hub.mu.Unlock()
}

func (h *Handler) registerResultMediaInput(jobKind, name, mime string, data []byte) map[string]any {
	sum := sha256.Sum256(data)
	hashHex := hex.EncodeToString(sum[:])
	now := h.hub.nowMs()
	in := ProtoMediaInput{
		ID:        randomID("in"),
		Kind:      jobKind,
		Name:      name,
		Mime:      mime,
		Size:      int64(len(data)),
		Phase:     "ready",
		Hash:      &hashHex,
		CreatedAt: now,
		ExpiresAt: now + 3600_000,
		CanDelete: false,
	}
	h.hub.mu.Lock()
	h.hub.state.MediaInputs[in.ID] = &mediaInputRecord{ProtoMediaInput: in, Bytes: data}
	h.hub.mu.Unlock()
	return map[string]any{
		"id":   in.ID,
		"kind": in.Kind,
		"name": in.Name,
		"mime": in.Mime,
		"size": in.Size,
		"hash": hashHex,
	}
}

func (h *Handler) offlineVoiceList(ctx context.Context, req setting.ProviderVoiceRequest) (setting.ProviderVoiceListing, bool, error) {
	if !offlineMediaEnabled() {
		return setting.ProviderVoiceListing{}, false, nil
	}
	st := h.st.Setting.ProviderStatus()
	if req.Revision != st.Revision {
		return setting.ProviderVoiceListing{}, true, fmt.Errorf("%w: provider settings changed", setting.ErrProviderRefused)
	}
	var conn *setting.ProviderConnection
	for i := range st.Connections {
		if st.Connections[i].ID == req.Connection && st.Connections[i].Enabled && st.Connections[i].Key.Source != nil {
			cp := st.Connections[i]
			conn = &cp
			break
		}
	}
	if conn == nil {
		return setting.ProviderVoiceListing{}, true, fmt.Errorf("%w: provider connection %q has no active key", setting.ErrProviderRefused, req.Connection)
	}
	hasAfter := strings.TrimSpace(req.After) != ""
	id := "voice-" + req.Connection
	if strings.Contains(req.Connection, "speech") || strings.Contains(req.Connection, "flash") || strings.Contains(req.Connection, "audio") {
		if hasAfter {
			id = "voice-two"
		} else {
			id = "voice-one"
		}
	} else if hasAfter {
		id += "-last"
	}
	voices := []setting.ProviderVoice{{
		ID:               id,
		Name:             "Offline voice",
		CreatedAtSeconds: 1,
	}}
	if !hasAfter {
		// Append any voices created via offline cloning during this run.
		h.hub.mu.RLock()
		for _, rec := range h.hub.state.MediaJobs {
			if rec == nil || rec.Kind != "clone" {
				continue
			}
			var m map[string]any
			if json.Unmarshal(rec.Raw, &m) == nil {
				if m["connection"] == req.Connection && m["phase"] == "ready" {
					if res, ok := m["result"].(map[string]any); ok {
						if v, ok := res["voice"].(map[string]any); ok {
							vid, _ := v["id"].(string)
							vname, _ := v["name"].(string)
							if vid != "" {
								voices = append(voices, setting.ProviderVoice{ID: vid, Name: vname, CreatedAtSeconds: 1})
							}
						}
					}
				}
			}
		}
		h.hub.mu.RUnlock()
	}
	var nextCursor *string
	if !hasAfter {
		c := "next-voice"
		nextCursor = &c
	}
	return setting.ProviderVoiceListing{
		Connection: req.Connection,
		Revision:   req.Revision,
		Voices:     voices,
		HasMore:    !hasAfter,
		NextCursor: nextCursor,
	}, true, nil
}

func (h *Handler) handleOfflineImageCreate(ctx context.Context, req struct {
	ID             string   `json:"id"`
	Prompt         string   `json:"prompt"`
	Format         string   `json:"format"`
	Width          int      `json:"width"`
	Height         int      `json:"height"`
	Seed           *int     `json:"seed"`
	Steps          *int     `json:"steps"`
	Guidance       *float64 `json:"guidance"`
	NegativePrompt string   `json:"negativePrompt"`
	Enhance        bool     `json:"enhance"`
	Watermark      bool     `json:"watermark"`
}) (json.RawMessage, error) {
	if req.Width < 256 || req.Width > 2048 || req.Height < 256 || req.Height > 2048 || req.Width%8 != 0 || req.Height%8 != 0 {
		return nil, newBizError(BizMediaRefused, "image dimensions must be between 256 and 2048 and divisible by 8")
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, newBizError(BizInvalidInput, "prompt is required")
	}
	h.hub.mu.RLock()
	if existing := h.hub.state.MediaJobs[req.ID]; existing != nil && len(existing.Raw) > 0 {
		rawCp := append(json.RawMessage(nil), existing.Raw...)
		h.hub.mu.RUnlock()
		return rawCp, nil
	}
	h.hub.mu.RUnlock()
	connID, modelID, rev, _, err := h.checkMossBinding("image", "", nil)
	if err != nil {
		return nil, err
	}

	now := h.hub.nowMs()
	job := map[string]any{
		"kind":             "image",
		"id":               req.ID,
		"prompt":           req.Prompt,
		"model":            firstNonEmpty(modelID, "moss-image-sft-1.0"),
		"connection":       connID,
		"revision":         rev,
		"source":           map[string]any{"kind": "user"},
		"phase":            "generating",
		"phaseText":        "Generating",
		"problem":          "",
		"canCancel":        true,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
	}

	switch {
	case strings.Contains(req.Prompt, "[media:hold]"):
		return h.saveMediaJob("image", job)
	case strings.Contains(req.Prompt, "[media:unknown]"):
		job["phase"] = "unknown"
		job["phaseText"] = "Unknown"
		job["problem"] = "Provider request failed (503)"
		job["canCancel"] = false
		return h.saveMediaJob("image", job)
	case strings.Contains(req.Prompt, "[media:download-failure]"):
		job["phase"] = "download_failed"
		job["phaseText"] = "Download failed"
		job["problem"] = "Download failed (503)"
		job["canCancel"] = false
		job["canRetryDownload"] = true
		job["_offlineWidth"] = req.Width
		job["_offlineHeight"] = req.Height
		return h.saveMediaJob("image", job)
	default:
		pngBytes, pErr := generateOfflinePNG(req.Width, req.Height)
		if pErr != nil {
			return nil, pErr
		}
		att, aErr := h.st.Attachments.PutBytes(ctx, req.ID+".png", "image/png", pngBytes)
		if aErr != nil {
			return nil, aErr
		}
		job["phase"] = "ready"
		job["phaseText"] = "Ready"
		job["canCancel"] = false
		job["attachment"] = att
		job["usage"] = map[string]any{
			"images": 1,
			"width":  req.Width,
			"height": req.Height,
		}
		h.addGeneratedLibraryItem(ctx, att.ID, req.ID, "image")
		return h.saveMediaJob("image", job)
	}
}

func (h *Handler) handleOfflineUnderstandingCreate(ctx context.Context, req struct {
	ID              string   `json:"id"`
	Prompt          string   `json:"prompt"`
	Inputs          []string `json:"inputs"`
	Connection      string   `json:"connection"`
	Revision        int      `json:"revision"`
	AllowUpload     bool     `json:"allowUpload"`
	MaxOutputTokens int      `json:"maxOutputTokens"`
	Channel         string   `json:"channel"`
}, authorizeOnly bool) (json.RawMessage, error) {
	h.hub.mu.RLock()
	if existing := h.hub.state.MediaJobs[req.ID]; existing != nil && len(existing.Raw) > 0 {
		rawCp := append(json.RawMessage(nil), existing.Raw...)
		h.hub.mu.RUnlock()
		return rawCp, nil
	}
	h.hub.mu.RUnlock()
	connID, modelID, rev, _, err := h.checkMossBinding("understanding", req.Connection, &req.Revision)
	if err != nil {
		return nil, err
	}
	h.hub.mu.RLock()
	var inputRefs []map[string]any
	hasVideo := false
	for _, inID := range req.Inputs {
		rec := h.hub.state.MediaInputs[inID]
		if rec == nil || rec.Hash == nil {
			h.hub.mu.RUnlock()
			return nil, newBizError(BizMediaRefused, "media input not found or not ready")
		}
		if rec.Kind == "video" {
			hasVideo = true
		}
		inputRefs = append(inputRefs, map[string]any{
			"id":   rec.ID,
			"kind": rec.Kind,
			"name": rec.Name,
			"mime": rec.Mime,
			"size": rec.Size,
			"hash": *rec.Hash,
		})
	}
	h.hub.mu.RUnlock()

	now := h.hub.nowMs()
	var authObj any
	if authorizeOnly {
		authObj = map[string]any{
			"channel":   req.Channel,
			"expiresAt": now + 3600_000,
		}
	}
	job := map[string]any{
		"kind":             "understanding",
		"id":               req.ID,
		"prompt":           req.Prompt,
		"inputs":           inputRefs,
		"model":            firstNonEmpty(modelID, "moss-vl-1.0"),
		"connection":       connID,
		"revision":         rev,
		"source":           map[string]any{"kind": "user"},
		"authorization":    authObj,
		"phase":            "generating",
		"phaseText":        "Understanding",
		"problem":          "",
		"result":           nil,
		"cleanup":          "pending",
		"cleanupText":      "Pending",
		"canCancel":        true,
		"canCleanup":       false,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
	}

	if authorizeOnly {
		job["phase"] = "authorized"
		job["phaseText"] = "Authorized"
		job["cleanup"] = "done"
		job["cleanupText"] = "Done"
		return h.saveMediaJob("understanding", job)
	}
	mediaKind := "image"
	if hasVideo {
		mediaKind = "video"
	}
	switch {
	case strings.Contains(req.Prompt, "[understanding:hold]"):
		return h.saveMediaJob("understanding", job)
	case strings.Contains(req.Prompt, "[understanding:unknown]"):
		job["phase"] = "unknown"
		job["phaseText"] = "Unknown"
		job["problem"] = "Provider request failed (503)"
		job["canCancel"] = false
		job["canCleanup"] = true
		return h.saveMediaJob("understanding", job)
	default:
		incomplete := strings.Contains(req.Prompt, "[understanding:incomplete]")
		cleanupFail := strings.Contains(req.Prompt, "[understanding:cleanup-failure]")
		status := "completed"
		var incompleteReason any
		phase := "ready"
		if incomplete {
			status = "incomplete"
			incompleteReason = "max_output_tokens"
			phase = "incomplete"
		}
		job["phase"] = phase
		job["phaseText"] = phase
		job["canCancel"] = false
		job["result"] = map[string]any{
			"model":            job["model"],
			"text":             fmt.Sprintf("Offline understanding of %s input.", mediaKind),
			"status":           status,
			"incompleteReason": incompleteReason,
			"usage": map[string]any{
				"inputTokens":  30,
				"outputTokens": 8,
				"totalTokens":  38,
			},
		}
		if cleanupFail {
			job["cleanup"] = "blocked"
			job["cleanupText"] = "Blocked"
			job["canCleanup"] = true
		} else {
			job["cleanup"] = "done"
			job["cleanupText"] = "Done"
			job["canCleanup"] = false
		}
		return h.saveMediaJob("understanding", job)
	}
}

func (h *Handler) handleOfflineSpeechCreate(ctx context.Context, req struct {
	ID           string `json:"id"`
	Text         string `json:"text"`
	Voice        string `json:"voice"`
	Format       string `json:"format"`
	Asynchronous bool   `json:"asynchronous"`
	Streaming    bool   `json:"streaming"`
	Connection   string `json:"connection"`
	Revision     int    `json:"revision"`
}) (json.RawMessage, error) {
	h.hub.mu.RLock()
	if existing := h.hub.state.MediaJobs[req.ID]; existing != nil && len(existing.Raw) > 0 {
		rawCp := append(json.RawMessage(nil), existing.Raw...)
		h.hub.mu.RUnlock()
		return rawCp, nil
	}
	h.hub.mu.RUnlock()
	connID, modelID, rev, _, err := h.checkMossBinding("speech", req.Connection, &req.Revision)
	if err != nil {
		return nil, err
	}

	now := h.hub.nowMs()
	format := firstNonEmpty(req.Format, "wav")
	if req.Streaming {
		format = "pcm"
	}
	job := map[string]any{
		"kind":             "speech",
		"id":               req.ID,
		"prompt":           req.Text,
		"model":            firstNonEmpty(modelID, "moss-tts-1.5-flash"),
		"connection":       connID,
		"revision":         rev,
		"source":           map[string]any{"kind": "user"},
		"voice":            firstNonEmpty(req.Voice, "voice-one"),
		"format":           format,
		"canRelease":       false,
		"canResume":        false,
		"phase":            "generating",
		"phaseText":        "Generating",
		"problem":          "",
		"resultInput":      nil,
		"canCancel":        true,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
		"_streaming":       req.Streaming,
	}

	if req.Streaming {
		return h.saveMediaJob("speech", job)
	}
	switch {
	case strings.Contains(req.Text, "[speech:hold]"):
		return h.saveMediaJob("speech", job)
	case strings.Contains(req.Text, "[speech:unknown]"):
		job["phase"] = "unknown"
		job["phaseText"] = "Unknown"
		job["problem"] = "Provider request failed (503)"
		job["canCancel"] = false
		return h.saveMediaJob("speech", job)
	case strings.Contains(req.Text, "[speech:download-failure]"):
		job["phase"] = "download_failed"
		job["phaseText"] = "Download failed"
		job["problem"] = "Download failed (503)"
		job["canCancel"] = false
		job["canRetryDownload"] = true
		return h.saveMediaJob("speech", job)
	case strings.Contains(req.Text, "[speech:large]"):
		samples := (26*1024*1024 - 44) / 2
		data := generateOfflineWAV(samples, 24000)
		job["phase"] = "ready"
		job["phaseText"] = "Ready"
		job["format"] = "wav"
		job["contentType"] = "audio/wav"
		job["canCancel"] = false
		job["canRelease"] = true
		job["resultInput"] = h.registerResultMediaInput("audio", req.ID+".wav", "audio/wav", data)
		job["metadata"] = map[string]any{
			"source":     "file",
			"sampleRate": 24000,
			"duration":   float64(samples) / 24000.0,
			"channels":   1,
			"bitDepth":   16,
		}
		return h.saveMediaJob("speech", job)
	default:
		var data []byte
		mime := "audio/wav"
		if format == "mp3" {
			data = generateOfflineMP3Frames()
			mime = "audio/mpeg"
		} else {
			data = generateOfflineWAV(24000, 24000)
			format = "wav"
		}
		att, aErr := h.st.Attachments.PutBytes(ctx, req.ID+"."+format, mime, data)
		if aErr != nil {
			return nil, aErr
		}
		job["phase"] = "ready"
		job["phaseText"] = "Ready"
		job["canCancel"] = false
		job["canRelease"] = true
		job["contentType"] = mime
		job["attachment"] = att
		job["resultInput"] = h.registerResultMediaInput("audio", req.ID+"."+format, mime, data)
		job["metadata"] = map[string]any{
			"source":     "file",
			"sampleRate": 24000,
			"duration":   1.0,
			"channels":   1,
			"bitDepth":   16,
		}
		h.addGeneratedLibraryItem(ctx, att.ID, req.ID, "speech")
		return h.saveMediaJob("speech", job)
	}
}

func (h *Handler) handleOfflineSpeechStream(w http.ResponseWriter, r *http.Request, id string) bool {
	if !offlineMediaEnabled() {
		return false
	}
	h.hub.mu.RLock()
	rec := h.hub.state.MediaJobs[id]
	h.hub.mu.RUnlock()
	if rec == nil || rec.Kind != "speech" {
		return false
	}
	var m map[string]any
	if json.Unmarshal(rec.Raw, &m) != nil {
		return false
	}
	prompt, _ := m["prompt"].(string)
	hold := strings.Contains(prompt, "[speech:stream-hold]")
	truncated := strings.Contains(prompt, "[speech:stream-truncated]")
	frames := 50
	if hold {
		frames = 1
	} else if truncated {
		frames = 10
	}

	flusher, ok := w.(http.Flusher)
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	writeLine := func(v any) bool {
		b, _ := json.Marshal(v)
		if _, err := w.Write(append(b, '\n')); err != nil {
			return false
		}
		if ok {
			flusher.Flush()
		}
		return true
	}

	if !writeLine(map[string]any{"type": "format", "sampleRate": 24000, "channels": 2, "bitDepth": 16}) {
		return true
	}
	chunk := stereoPCMChunkBase64()
	for i := 0; i < frames; i++ {
		select {
		case <-r.Context().Done():
			return true
		case <-time.After(35 * time.Millisecond):
		}
		if !writeLine(map[string]any{"type": "audio", "sequence": i, "audio": chunk}) {
			return true
		}
	}
	if hold {
		for {
			h.hub.mu.RLock()
			cur := h.hub.state.MediaJobs[id]
			canceled := false
			if cur != nil {
				var cm map[string]any
				if json.Unmarshal(cur.Raw, &cm) == nil && cm["phase"] == "canceled" {
					canceled = true
				}
			}
			h.hub.mu.RUnlock()
			if canceled {
				_ = writeLine(map[string]any{"type": "failed"})
				return true
			}
			select {
			case <-r.Context().Done():
				return true
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	if truncated {
		h.hub.mu.Lock()
		m["phase"] = "unknown"
		m["phaseText"] = "Unknown"
		m["problem"] = "Speech stream ended before completion"
		m["canCancel"] = false
		m["canResume"] = false
		m["updatedAt"] = h.hub.nowMs()
		raw, _ := json.Marshal(m)
		rec.Raw = raw
		h.hub.mu.Unlock()
		_ = h.hub.persist()
		h.hub.notifyAllState()
		_ = writeLine(map[string]any{"type": "failed"})
		return true
	}

	// Success: finalize speech job with saved stereo WAV attachment matching stream format.
	wavBytes := generateOfflineStereoWAV(24000, 24000)
	att, aErr := h.st.Attachments.PutBytes(r.Context(), id+".wav", "audio/wav", wavBytes)
	h.hub.mu.Lock()
	m["phase"] = "ready"
	m["phaseText"] = "Ready"
	m["canCancel"] = false
	m["canRelease"] = true
	m["format"] = "wav"
	m["contentType"] = "audio/wav"
	if aErr == nil {
		m["attachment"] = att
	}
	m["resultInput"] = h.registerResultMediaInputUnlocked(id+".wav", "audio/wav", wavBytes)
	m["metadata"] = map[string]any{"source": "provider", "sampleRate": 24000, "duration": 1.0, "channels": 2, "bitDepth": 16}
	m["usage"] = map[string]any{"inputCharacters": len(prompt), "promptTokens": 5, "completionTokens": frames, "totalTokens": 5 + frames}
	m["updatedAt"] = h.hub.nowMs()
	raw, _ := json.Marshal(m)
	rec.Raw = raw
	h.hub.mu.Unlock()
	if aErr == nil {
		h.addGeneratedLibraryItem(r.Context(), att.ID, id, "speech")
	}
	_ = h.hub.persist()
	h.hub.notifyAllState()
	_ = writeLine(map[string]any{"type": "done"})
	return true
}

func (h *Handler) registerResultMediaInputUnlocked(name, mime string, data []byte) map[string]any {
	sum := sha256.Sum256(data)
	hashHex := hex.EncodeToString(sum[:])
	now := h.hub.nowMs()
	in := ProtoMediaInput{
		ID:        randomID("in"),
		Kind:      "audio",
		Name:      name,
		Mime:      mime,
		Size:      int64(len(data)),
		Phase:     "ready",
		Hash:      &hashHex,
		CreatedAt: now,
		ExpiresAt: now + 3600_000,
		CanDelete: false,
	}
	h.hub.state.MediaInputs[in.ID] = &mediaInputRecord{ProtoMediaInput: in, Bytes: data}
	return map[string]any{
		"id":   in.ID,
		"kind": in.Kind,
		"name": in.Name,
		"mime": in.Mime,
		"size": in.Size,
		"hash": hashHex,
	}
}

func (h *Handler) handleOfflineAudioCreate(ctx context.Context, kind string, bodyMap map[string]any) (json.RawMessage, error) {
	id, _ := bodyMap["id"].(string)
	connReq, _ := bodyMap["connection"].(string)
	revReq := 0
	if v, ok := bodyMap["revision"].(float64); ok {
		revReq = int(v)
	}
	h.hub.mu.RLock()
	if existing := h.hub.state.MediaJobs[id]; existing != nil && len(existing.Raw) > 0 {
		rawCp := append(json.RawMessage(nil), existing.Raw...)
		h.hub.mu.RUnlock()
		return rawCp, nil
	}
	h.hub.mu.RUnlock()
	connID, modelID, rev, conn, err := h.checkMossBinding(kind, connReq, &revReq)
	if err != nil {
		return nil, err
	}

	keyHint := ""
	if conn != nil {
		keyHint = conn.Key.Hint
	}

	var inputRef map[string]any
	if inID, ok := bodyMap["input"].(string); ok && inID != "" {
		h.hub.mu.RLock()
		rec := h.hub.state.MediaInputs[inID]
		h.hub.mu.RUnlock()
		if rec == nil || rec.Hash == nil {
			return nil, newBizError(BizMediaRefused, "media input not ready")
		}
		inputRef = map[string]any{
			"id":   rec.ID,
			"kind": rec.Kind,
			"name": rec.Name,
			"mime": rec.Mime,
			"size": rec.Size,
			"hash": *rec.Hash,
		}
	}

	prompt := ""
	switch kind {
	case "speakers":
		if segs, ok := bodyMap["segments"].([]any); ok {
			var parts []string
			for _, seg := range segs {
				if sm, ok := seg.(map[string]any); ok {
					if t, ok := sm["text"].(string); ok {
						parts = append(parts, t)
					}
				}
			}
			prompt = strings.Join(parts, " ")
		}
	case "voiceDesign":
		prompt, _ = bodyMap["text"].(string)
	case "clone":
		prompt, _ = bodyMap["name"].(string)
	case "transcription":
		prompt = "transcription"
	}

	now := h.hub.nowMs()
	var formatAny any
	if f, ok := bodyMap["format"].(string); ok && f != "" {
		formatAny = f
	}
	job := map[string]any{
		"kind":             kind,
		"id":               id,
		"prompt":           prompt,
		"model":            firstNonEmpty(modelID, "default"),
		"connection":       connID,
		"revision":         rev,
		"source":           map[string]any{"kind": "user"},
		"phase":            "generating",
		"phaseText":        "Generating",
		"problem":          "",
		"format":           formatAny,
		"contentType":      nil,
		"input":            inputRef,
		"resultInput":      nil,
		"previewInput":     nil,
		"result":           nil,
		"canCancel":        true,
		"canResume":        false,
		"canCleanup":       false,
		"canRelease":       false,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
		"request":          bodyMap,
	}

	switch kind {
	case "clone":
		vName := firstNonEmpty(prompt, "Cloned Voice")
		vID := "voice-cloned-" + id
		if len(vID) > 32 {
			vID = vID[:32]
		}
		job["phase"] = "ready"
		job["phaseText"] = "Ready"
		job["canCancel"] = false
		job["canCleanup"] = true
		job["result"] = map[string]any{
			"kind": "clone",
			"voice": map[string]any{
				"id":               vID,
				"name":             vName,
				"createdAtSeconds": 1,
			},
		}
		return h.saveMediaJob(kind, job)

	case "transcription":
		streaming, _ := bodyMap["streaming"].(bool)
		if strings.HasSuffix(keyHint, "lure") {
			job["phase"] = "failed"
			job["phaseText"] = "Failed"
			job["problem"] = "Provider transcription failed"
			job["canCancel"] = false
			job["canCleanup"] = true
			return h.saveMediaJob(kind, job)
		}
		if streaming {
			job["phase"] = "generating"
			job["result"] = map[string]any{
				"kind": "transcription",
				"text": "First synthetic speaker.",
				"segments": []map[string]any{
					{"speaker": "speaker_0", "text": "First synthetic speaker.", "start": 0, "end": 1.4},
				},
			}
			raw, err := h.saveMediaJob(kind, job)
			if err != nil {
				return nil, err
			}
			hold := strings.HasSuffix(keyHint, "hold")
			truncated := strings.HasSuffix(keyHint, "ated")
			if !hold {
				go h.finishOfflineTranscriptionStream(id, truncated)
			}
			return raw, nil
		}
		job["phase"] = "ready"
		job["phaseText"] = "Ready"
		job["canCancel"] = false
		job["canCleanup"] = true
		job["result"] = map[string]any{
			"kind": "transcription",
			"text": "First synthetic speaker. Second synthetic speaker.",
			"segments": []map[string]any{
				{"speaker": "speaker_0", "text": "First synthetic speaker.", "start": 0, "end": 1.4},
				{"speaker": "speaker_1", "text": "Second synthetic speaker.", "start": 1.5, "end": 3},
			},
		}
		return h.saveMediaJob(kind, job)

	default: // speakers, voiceDesign
		if strings.Contains(prompt, "[audio:hold]") {
			return h.saveMediaJob(kind, job)
		}
		if strings.Contains(prompt, "[audio:unknown]") {
			job["phase"] = "unknown"
			job["phaseText"] = "Unknown"
			job["problem"] = "Provider request failed (503)"
			job["canCancel"] = false
			return h.saveMediaJob(kind, job)
		}
		if strings.Contains(prompt, "[audio:download-failure]") {
			job["phase"] = "download_failed"
			job["phaseText"] = "Download failed"
			job["problem"] = "Download failed (503)"
			job["canCancel"] = false
			job["canRetryDownload"] = true
			return h.saveMediaJob(kind, job)
		}
		if strings.Contains(prompt, "[audio:large]") {
			samples := (26*1024*1024 - 44) / 2
			data := generateOfflineWAV(samples, 24000)
			job["phase"] = "ready"
			job["phaseText"] = "Ready"
			job["format"] = "wav"
			job["contentType"] = "audio/wav"
			job["canCancel"] = false
			job["canRelease"] = true
			job["resultInput"] = h.registerResultMediaInput("audio", id+".wav", "audio/wav", data)
			job["metadata"] = map[string]any{
				"source":     "file",
				"sampleRate": 24000,
				"duration":   float64(samples) / 24000.0,
				"channels":   1,
				"bitDepth":   16,
			}
			return h.saveMediaJob(kind, job)
		}
		fmtStr, _ := formatAny.(string)
		if fmtStr == "" {
			fmtStr = "wav"
		}
		var data []byte
		mime := "audio/wav"
		if fmtStr == "mp3" {
			data = generateOfflineMP3Frames()
			mime = "audio/mpeg"
		} else {
			data = generateOfflineWAV(24000, 24000)
			fmtStr = "wav"
		}
		att, aErr := h.st.Attachments.PutBytes(ctx, id+"."+fmtStr, mime, data)
		if aErr != nil {
			return nil, aErr
		}
		job["phase"] = "ready"
		job["phaseText"] = "Ready"
		job["format"] = fmtStr
		job["contentType"] = mime
		job["canCancel"] = false
		job["canRelease"] = true
		job["attachment"] = att
		ri := h.registerResultMediaInput("audio", id+"."+fmtStr, mime, data)
		job["resultInput"] = ri
		if kind == "voiceDesign" {
			job["previewInput"] = ri["id"]
		}
		job["metadata"] = map[string]any{"source": "file", "sampleRate": 24000, "duration": 1.0, "channels": 1, "bitDepth": 16}
		h.addGeneratedLibraryItem(ctx, att.ID, id, kind)
		return h.saveMediaJob(kind, job)
	}
}

func (h *Handler) finishOfflineTranscriptionStream(id string, truncated bool) {
	time.Sleep(1000 * time.Millisecond)
	h.hub.mu.Lock()
	rec := h.hub.state.MediaJobs[id]
	if rec == nil {
		h.hub.mu.Unlock()
		return
	}
	var m map[string]any
	if json.Unmarshal(rec.Raw, &m) != nil {
		h.hub.mu.Unlock()
		return
	}
	if m["phase"] == "canceled" {
		h.hub.mu.Unlock()
		return
	}
	if truncated {
		m["phase"] = "unknown"
		m["phaseText"] = "Unknown"
		m["canCancel"] = false
		m["canCleanup"] = true
		m["updatedAt"] = h.hub.nowMs()
		raw, _ := json.Marshal(m)
		rec.Raw = raw
		h.hub.mu.Unlock()
		_ = h.hub.persist()
		h.hub.notifyAllState()
		return
	}
	m["phase"] = "ready"
	m["phaseText"] = "Ready"
	m["canCancel"] = false
	m["canCleanup"] = true
	m["result"] = map[string]any{
		"kind": "transcription",
		"text": "First synthetic speaker. Second synthetic speaker.",
		"segments": []map[string]any{
			{"speaker": "speaker_0", "text": "First synthetic speaker.", "start": 0, "end": 1.4},
			{"speaker": "speaker_1", "text": "Second synthetic speaker.", "start": 1.5, "end": 3},
		},
	}
	m["updatedAt"] = h.hub.nowMs()
	raw, _ := json.Marshal(m)
	rec.Raw = raw
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
}

func (h *Handler) handleOfflineMediaJobAction(ctx context.Context, action, id string) (json.RawMessage, bool, error) {
	if !offlineMediaEnabled() {
		return nil, false, nil
	}
	h.hub.mu.Lock()
	rec := h.hub.state.MediaJobs[id]
	if rec == nil {
		h.hub.mu.Unlock()
		return nil, true, newBizError(BizMediaNotFound, "media job not found")
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Raw, &m); err != nil {
		h.hub.mu.Unlock()
		return nil, true, newBizError(BizMediaRefused, "invalid job record")
	}
	kind, _ := m["kind"].(string)
	now := h.hub.nowMs()

	switch action {
	case "cancel":
		if canCancel, _ := m["canCancel"].(bool); !canCancel {
			rawCp := append(json.RawMessage(nil), rec.Raw...)
			h.hub.mu.Unlock()
			return rawCp, true, nil
		}
		m["phase"] = "canceled"
		m["phaseText"] = "Canceled"
		m["canCancel"] = false
		if kind == "understanding" || kind == "transcription" || kind == "clone" {
			m["cleanup"] = "done"
			m["cleanupText"] = "Done"
			m["canCleanup"] = false
		}
		m["updatedAt"] = now
	case "cleanup":
		m["cleanup"] = "done"
		m["cleanupText"] = "Done"
		m["canCleanup"] = false
		m["updatedAt"] = now
	case "release":
		m["canRelease"] = false
		if ri, ok := m["resultInput"].(map[string]any); ok {
			if rid, _ := ri["id"].(string); rid != "" {
				delete(h.hub.state.MediaInputs, rid)
			}
		}
		m["resultInput"] = nil
		m["updatedAt"] = now
	case "download":
		if kind == "image" {
			w := 256
			ht := 256
			if v, ok := m["_offlineWidth"].(float64); ok && v > 0 {
				w = int(v)
			}
			if v, ok := m["_offlineHeight"].(float64); ok && v > 0 {
				ht = int(v)
			}
			h.hub.mu.Unlock()
			pngBytes, pErr := generateOfflinePNG(w, ht)
			if pErr != nil {
				return nil, true, pErr
			}
			att, aErr := h.st.Attachments.PutBytes(ctx, id+".png", "image/png", pngBytes)
			if aErr != nil {
				return nil, true, aErr
			}
			h.hub.mu.Lock()
			rec = h.hub.state.MediaJobs[id]
			if rec != nil {
				_ = json.Unmarshal(rec.Raw, &m)
				m["phase"] = "ready"
				m["phaseText"] = "Ready"
				m["problem"] = ""
				m["canRetryDownload"] = false
				m["attachment"] = att
				m["usage"] = map[string]any{"images": 1, "width": w, "height": ht}
				m["updatedAt"] = now
				raw, _ := json.Marshal(m)
				rec.Raw = raw
				h.hub.mu.Unlock()
				h.addGeneratedLibraryItem(ctx, att.ID, id, "image")
				_ = h.hub.persist()
				h.hub.notifyAllState()
				return raw, true, nil
			}
			h.hub.mu.Unlock()
			return nil, true, newBizError(BizMediaNotFound, "media job not found")
		} else if kind == "speech" || kind == "speakers" || kind == "voiceDesign" {
			fmtStr, _ := m["format"].(string)
			if fmtStr == "" {
				fmtStr = "wav"
			}
			h.hub.mu.Unlock()
			data := generateOfflineWAV(24000, 24000)
			mime := "audio/wav"
			if fmtStr == "mp3" {
				data = generateOfflineMP3Frames()
				mime = "audio/mpeg"
			}
			att, aErr := h.st.Attachments.PutBytes(ctx, id+"."+fmtStr, mime, data)
			if aErr != nil {
				return nil, true, aErr
			}
			h.hub.mu.Lock()
			rec = h.hub.state.MediaJobs[id]
			if rec != nil {
				_ = json.Unmarshal(rec.Raw, &m)
				m["phase"] = "ready"
				m["phaseText"] = "Ready"
				m["problem"] = ""
				m["canRetryDownload"] = false
				m["canRelease"] = true
				m["contentType"] = mime
				m["attachment"] = att
				m["resultInput"] = h.registerResultMediaInputUnlocked(id+"."+fmtStr, mime, data)
				m["updatedAt"] = now
				raw, _ := json.Marshal(m)
				rec.Raw = raw
				h.hub.mu.Unlock()
				h.addGeneratedLibraryItem(ctx, att.ID, id, kind)
				_ = h.hub.persist()
				h.hub.notifyAllState()
				return raw, true, nil
			}
			h.hub.mu.Unlock()
			return nil, true, newBizError(BizMediaNotFound, "media job not found")
		}
	case "start":
		if kind == "understanding" {
			m["phase"] = "ready"
			m["phaseText"] = "Ready"
			m["cleanup"] = "done"
			m["cleanupText"] = "Done"
			m["canCancel"] = false
			m["updatedAt"] = now
		}
	case "resume":
		// Preserve current state for resume if already ready or failed.
	case "get":
		rawCp := append(json.RawMessage(nil), rec.Raw...)
		h.hub.mu.Unlock()
		return rawCp, true, nil
	}

	raw, _ := json.Marshal(m)
	rec.Raw = raw
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	return raw, true, nil
}

// Keep slices used for any future connection checks cleanly
var _ = slices.Contains[[]string, string]
