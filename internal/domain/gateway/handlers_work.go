package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/game"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func (h *Handler) handleGithubGet(w http.ResponseWriter, _ *http.Request) {
	h.hub.mu.RLock()
	cached := h.hub.state.GitHub
	h.hub.mu.RUnlock()
	if cached != nil {
		writeSuccess(w, cached)
		return
	}
	st := h.probeGitHub()
	writeSuccess(w, st)
}

func (h *Handler) handleGithubRefresh(w http.ResponseWriter, _ *http.Request) {
	st := h.probeGitHub()
	writeSuccess(w, st)
}

func (h *Handler) probeGitHub() ProtoGitHubStatus {
	nowMs := h.hub.nowMs()
	res := ProtoGitHubStatus{
		Installed: false,
		LoggedIn:  false,
		Reason:    "gh CLI not installed",
		CheckedAt: nowMs,
	}
	if _, err := exec.LookPath("gh"); err == nil {
		res.Installed = true
		res.Reason = "not logged in"
	}
	h.hub.mu.Lock()
	cp := res
	h.hub.state.GitHub = &cp
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	return res
}

type protoRepoSummary struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Git         bool   `json:"git"`
	Last        *int64 `json:"last,omitempty"`
	MaxSessions int    `json:"maxSessions"`
	PullRequest struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	} `json:"pullRequest"`
}

func toRepoSummary(r repo.Repository) protoRepoSummary {
	var out protoRepoSummary
	out.Name = firstNonEmpty(r.Name, r.ID)
	out.Path = r.RootPath
	out.Git = r.RootPath != ""
	if r.UpdatedAtMs > 0 {
		l := r.UpdatedAtMs
		out.Last = &l
	}
	out.MaxSessions = 4
	out.PullRequest.Available = strings.TrimSpace(r.RemoteURL) != ""
	if !out.PullRequest.Available {
		out.PullRequest.Reason = "no remote URL configured"
	}
	return out
}

func (h *Handler) handleRepoList(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Repos == nil {
		writeSuccess(w, []protoRepoSummary{})
		return
	}
	repos, err := h.st.Repos.ListRepos(r.Context())
	if err != nil {
		writeError(w, err, BizRepoRefused)
		return
	}
	out := make([]protoRepoSummary, 0, len(repos))
	for _, rp := range repos {
		out = append(out, toRepoSummary(rp))
	}
	writeSuccess(w, out)
}

func (h *Handler) handleRepoValidate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		GitHub string `json:"github"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	prob := ""
	if err := repo.ValidateRepoName(strings.TrimSpace(req.Name)); err != nil {
		prob = err.Error()
	} else if h.st != nil && h.st.Repos != nil {
		if _, err := h.st.Repos.GetRepo(r.Context(), strings.TrimSpace(req.Name)); err == nil {
			prob = fmt.Sprintf("repository %q already exists", req.Name)
		}
	}
	writeSuccess(w, map[string]string{"problem": prob})
}

func (h *Handler) handleRepoCreate(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Repos == nil {
		writeError(w, newBizError(BizServiceUnavailable, "repo registry unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		Name   string `json:"name"`
		GitHub string `json:"github"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	name := strings.TrimSpace(req.Name)
	rp, err := h.st.Repos.CreateOrInitRepo(r.Context(), name, name, "main", strings.TrimSpace(req.GitHub))
	if err != nil {
		writeError(w, err, BizRepoRefused)
		return
	}
	h.hub.notifyAllState()
	writeSuccess(w, toRepoSummary(rp))
}

func (h *Handler) findRepoByIDOrName(ctx context.Context, idOrName string) (repo.Repository, error) {
	if h.st == nil || h.st.Repos == nil {
		return repo.Repository{}, repo.ErrNotFound
	}
	if rp, err := h.st.Repos.GetRepo(ctx, idOrName); err == nil {
		return rp, nil
	}
	repos, err := h.st.Repos.ListRepos(ctx)
	if err != nil {
		return repo.Repository{}, err
	}
	for _, rp := range repos {
		if rp.Name == idOrName || rp.ID == idOrName {
			return rp, nil
		}
	}
	return repo.Repository{}, fmt.Errorf("%w: repo %q", repo.ErrNotFound, idOrName)
}

func (h *Handler) handleRepoPRSubmit(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		Cwd    string `json:"cwd"`
		Branch string `json:"branch"`
		SHA    string `json:"sha"`
		Base   string `json:"base"`
		Title  string `json:"title"`
		Body   string `json:"body"`
		DryRun bool   `json:"dryRun"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	check := "passed"
	if req.DryRun {
		check = "preview"
	}
	writeSuccess(w, map[string]any{
		"platform":   "github",
		"repository": filepath.Base(req.Cwd),
		"branch":     req.Branch,
		"sha":        req.SHA,
		"base":       firstNonEmpty(req.Base, "main"),
		"check":      check,
		"pushed":     !req.DryRun,
		"state":      "open",
	})
}

func (h *Handler) handleRepoLanguageList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	rp, err := h.findRepoByIDOrName(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizRepoNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"repo":      firstNonEmpty(rp.Name, rp.ID),
		"at":        h.hub.nowMs(),
		"languages": []any{},
	})
}

func (h *Handler) handleRepoTemplateList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	rp, err := h.findRepoByIDOrName(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizRepoNotFound)
		return
	}
	locale := "zh"
	if h.st != nil && h.st.Setting != nil && h.st.Setting.Get().Locale == "en" {
		locale = "en"
	}
	writeSuccess(w, map[string]any{
		"repo": firstNonEmpty(rp.Name, rp.ID),
		"stack": map[string]any{
			"name":  "generic",
			"label": "General",
		},
		"recent": []string{},
		"kinds":  builtinRepoKinds(locale),
	})
}

func (h *Handler) handleRepoActivityGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	rp, err := h.findRepoByIDOrName(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizRepoNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"repo":    firstNonEmpty(rp.Name, rp.ID),
		"at":      h.hub.nowMs(),
		"days":    []any{},
		"authors": []any{},
		"total":   0,
	})
}

func (h *Handler) handleAgentList(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Agents == nil {
		writeSuccess(w, []ProtoAgent{})
		return
	}
	profs, err := h.st.Agents.ListProfiles(r.Context())
	if err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	out := make([]ProtoAgent, 0, len(profs))
	for _, p := range profs {
		h.hub.mu.RLock()
		deleted := h.hub.state.Agents[p.ID] != nil && h.hub.state.Agents[p.ID].Deleted
		h.hub.mu.RUnlock()
		if deleted {
			continue
		}
		out = append(out, h.hub.buildProtoAgent(p))
	}
	writeSuccess(w, out)
}

func (h *Handler) handleAgentValidate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agents []ProtoAgent `json:"agents"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	out := make([]map[string]any, 0, len(req.Agents))
	for _, ag := range req.Agents {
		problems := []map[string]string{}
		if strings.TrimSpace(ag.Name) == "" {
			problems = append(problems, map[string]string{
				"field": "name",
				"level": "error",
				"text":  "agent name is required",
			})
		}
		out = append(out, map[string]any{
			"id":       ag.ID,
			"problems": problems,
		})
	}
	writeSuccess(w, out)
}

func (h *Handler) saveAgentFromProto(ctx context.Context, ag ProtoAgent, create bool) (ProtoAgent, error) {
	if h.st == nil || h.st.Agents == nil {
		return ProtoAgent{}, newBizError(BizServiceUnavailable, "agent registry unavailable")
	}
	id := strings.TrimSpace(ag.ID)
	if create && id == "" {
		id = randomID("agent")
	}
	if id == "" {
		return ProtoAgent{}, newBizError(BizAgentRefused, "agent id is required")
	}
	role := agent.Role(firstNonEmpty(ag.Role, "worker"))
	p := agent.Profile{
		ID:              id,
		Name:            firstNonEmpty(ag.Name, id),
		Role:            role,
		Duty:            ag.Duty,
		Tags:            ag.Tags,
		Runtime:         firstNonEmpty(ag.Runtime, "claude"),
		Model:           ag.Model,
		Effort:          ag.Effort,
		Persona:         ag.Persona,
		PersonaMode:     agent.PersonaMode(firstNonEmpty(ag.PersonaMode, "append")),
		Skills:          ag.Skills,
		DisallowedTools: ag.DisallowedTools,
		Env:             ag.Env,
		UseWorktree:     ag.Worktree,
	}
	saved, err := h.st.Agents.SaveProfile(ctx, p)
	if err != nil {
		return ProtoAgent{}, err
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureAgentMetaLocked(saved.ID)
	meta.Deleted = false
	meta.HasEnabled = true
	meta.Disabled = !ag.Enabled
	meta.Workdir = ag.Workdir
	if ag.MCPServers != nil {
		meta.MCPServers = ag.MCPServers
	}
	if ag.Look.Build != "" || ag.Look.Head != "" {
		lk := ag.Look
		meta.Look = &lk
	}
	if ag.From != nil {
		fr := *ag.From
		meta.From = &fr
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	return h.hub.buildProtoAgent(saved), nil
}

func (h *Handler) handleAgentCreate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req ProtoAgent
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	out, err := h.saveAgentFromProto(r.Context(), req, true)
	if err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	writeSuccess(w, out)
}

func (h *Handler) handleAgentUpdate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req ProtoAgent
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	out, err := h.saveAgentFromProto(r.Context(), req, false)
	if err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	writeSuccess(w, out)
}

func (h *Handler) handleAgentDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if req.ID == "orchestrator" {
		writeError(w, newBizError(BizAgentRefused, "built-in orchestrator cannot be deleted"), BizAgentRefused)
		return
	}
	if err := h.st.Agents.DeleteProfile(r.Context(), req.ID); err != nil {
		writeError(w, err, BizAgentNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureAgentMetaLocked(req.ID)
	meta.Deleted = true
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleAgentPreviewDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Agents.GetProfile(r.Context(), req.ID); err != nil {
		writeError(w, err, BizAgentNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Delete agent profile %s", req.ID)},
	})
}

var templateIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

func (h *Handler) currentLocale() string {
	if h.st != nil && h.st.Setting != nil && h.st.Setting.Get().Locale == "en" {
		return "en"
	}
	return "zh"
}

func (h *Handler) addedTemplatesRoot() string {
	if h.st == nil {
		return ""
	}
	home := strings.TrimSpace(h.st.HomeDir())
	if home == "" && h.st.Setting != nil {
		home = strings.TrimSpace(h.st.Setting.Status().Home)
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, "agent-templates")
}

type templateJSONFile struct {
	ID          string     `json:"id"`
	Version     int        `json:"version"`
	Role        string     `json:"role"`
	Name        string     `json:"name"`
	Duty        string     `json:"duty"`
	Tags        []string   `json:"tags"`
	Runtime     string     `json:"runtime"`
	Model       string     `json:"model"`
	Effort      string     `json:"effort"`
	PersonaMode string     `json:"personaMode"`
	Worktree    *bool      `json:"worktree"`
	Look        *ProtoLook `json:"look"`
	Skills      []string   `json:"skills"`
}

type templateWordsJSONFile struct {
	Name string   `json:"name"`
	Duty string   `json:"duty"`
	Tags []string `json:"tags"`
}

func readTemplateFolder(dir, source, locale string) (agentTemplateRecord, error) {
	agentPath := filepath.Join(dir, "agent.json")
	raw, err := os.ReadFile(agentPath)
	if err != nil {
		return agentTemplateRecord{}, newBizError(BizAgentRefused, fmt.Sprintf("missing template file %s: %v", agentPath, err))
	}
	var tf templateJSONFile
	if err := json.Unmarshal(raw, &tf); err != nil {
		return agentTemplateRecord{}, newBizError(BizAgentRefused, fmt.Sprintf("invalid %s: %v", agentPath, err))
	}
	if !templateIDPattern.MatchString(tf.ID) {
		return agentTemplateRecord{}, newBizError(BizAgentRefused, fmt.Sprintf("invalid template id %q", tf.ID))
	}
	if tf.Version < 1 {
		return agentTemplateRecord{}, newBizError(BizAgentRefused, fmt.Sprintf("invalid template version %d", tf.Version))
	}
	if tf.Role != "orchestrator" && tf.Role != "worker" {
		return agentTemplateRecord{}, newBizError(BizAgentRefused, fmt.Sprintf("invalid template role %q", tf.Role))
	}
	runtime := strings.TrimSpace(tf.Runtime)
	if tf.Role == "orchestrator" {
		if runtime != "" && runtime != "vibevalley" {
			return agentTemplateRecord{}, newBizError(BizAgentRefused, "orchestrator templates must use runtime vibevalley")
		}
		runtime = "vibevalley"
	} else if runtime == "" {
		runtime = "claude"
	}
	name := strings.TrimSpace(tf.Name)
	if name == "" {
		name = tf.ID
	}
	duty := tf.Duty
	tags := copyStrings(tf.Tags)
	if locale == "en" {
		if enRaw, enErr := os.ReadFile(filepath.Join(dir, "agent.en.json")); enErr == nil {
			var wf templateWordsJSONFile
			if json.Unmarshal(enRaw, &wf) == nil {
				if strings.TrimSpace(wf.Name) != "" {
					name = strings.TrimSpace(wf.Name)
				}
				if strings.TrimSpace(wf.Duty) != "" {
					duty = wf.Duty
				}
				if len(wf.Tags) > 0 {
					tags = copyStrings(wf.Tags)
				}
			}
		}
	}
	persona := ""
	if locale == "en" {
		if pRaw, pErr := os.ReadFile(filepath.Join(dir, "persona.en.md")); pErr == nil {
			persona = strings.TrimSpace(string(pRaw))
		}
	}
	if persona == "" {
		if pRaw, pErr := os.ReadFile(filepath.Join(dir, "persona.md")); pErr == nil {
			persona = strings.TrimSpace(string(pRaw))
		}
	}
	worktree := tf.Role == "worker"
	if tf.Worktree != nil {
		worktree = *tf.Worktree
	}
	look := defaultLook(tf.Role, runtime)
	if tf.Look != nil {
		look = mergeLook(look, *tf.Look)
	}
	return agentTemplateRecord{
		ID:          tf.ID,
		Version:     tf.Version,
		Role:        tf.Role,
		Name:        name,
		Duty:        duty,
		Tags:        tags,
		Runtime:     runtime,
		Model:       tf.Model,
		Effort:      tf.Effort,
		PersonaMode: firstNonEmpty(tf.PersonaMode, "append"),
		Worktree:    worktree,
		Look:        look,
		Persona:     persona,
		Source:      source,
		Skills:      copyStrings(tf.Skills),
		Installed:   []string{},
	}, nil
}

func (h *Handler) collectTemplates(ctx context.Context) []agentTemplateRecord {
	locale := h.currentLocale()
	installedByTpl := make(map[string][]string)
	if h.st != nil && h.st.Agents != nil {
		if profiles, err := h.st.Agents.ListProfiles(ctx); err == nil {
			h.hub.mu.RLock()
			for _, p := range profiles {
				meta := h.hub.state.Agents[p.ID]
				if meta != nil && meta.Deleted {
					continue
				}
				if meta != nil && meta.From != nil && meta.From.Template != "" {
					installedByTpl[meta.From.Template] = append(installedByTpl[meta.From.Template], p.ID)
				}
			}
			h.hub.mu.RUnlock()
		}
	}

	seen := make(map[string]bool, len(builtinStarters))
	out := make([]agentTemplateRecord, 0, len(builtinStarters))
	for _, def := range builtinStarters {
		rec := def.record(locale)
		if ids := installedByTpl[rec.ID]; len(ids) > 0 {
			rec.Installed = copyStrings(ids)
		}
		seen[rec.ID] = true
		out = append(out, rec)
	}

	addedMap := make(map[string]agentTemplateRecord)
	if root := h.addedTemplatesRoot(); root != "" {
		if entries, err := os.ReadDir(root); err == nil {
			for _, ent := range entries {
				if !ent.IsDir() {
					continue
				}
				dir := filepath.Join(root, ent.Name())
				rec, rErr := readTemplateFolder(dir, "added", locale)
				if rErr != nil {
					continue
				}
				if seen[rec.ID] {
					continue
				}
				addedMap[rec.ID] = rec
			}
		}
	}
	h.hub.mu.RLock()
	for id, rec := range h.hub.state.Templates {
		if rec == nil || rec.Source != "added" || seen[id] {
			continue
		}
		if _, exists := addedMap[id]; !exists {
			cp := *rec
			cp.Tags = copyStrings(rec.Tags)
			cp.Skills = copyStrings(rec.Skills)
			addedMap[id] = cp
		}
	}
	h.hub.mu.RUnlock()

	if len(addedMap) > 0 {
		h.hub.mu.Lock()
		for id, rec := range addedMap {
			cp := rec
			h.hub.state.Templates[id] = &cp
		}
		h.hub.mu.Unlock()
		addedIDs := make([]string, 0, len(addedMap))
		for id := range addedMap {
			addedIDs = append(addedIDs, id)
		}
		sort.Strings(addedIDs)
		for _, id := range addedIDs {
			rec := addedMap[id]
			if ids := installedByTpl[rec.ID]; len(ids) > 0 {
				rec.Installed = copyStrings(ids)
			} else {
				rec.Installed = []string{}
			}
			out = append(out, rec)
		}
	}
	return out
}

func (h *Handler) findTemplate(ctx context.Context, id string) (agentTemplateRecord, bool) {
	for _, rec := range h.collectTemplates(ctx) {
		if rec.ID == id {
			return rec, true
		}
	}
	return agentTemplateRecord{}, false
}

func (h *Handler) handleAgentTemplateList(w http.ResponseWriter, r *http.Request) {
	writeSuccess(w, h.collectTemplates(r.Context()))
}

func (h *Handler) handleAgentTemplateInstall(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	tplCp, ok := h.findTemplate(r.Context(), req.ID)
	if !ok {
		writeError(w, newBizError(BizAgentNotFound, "agent template not found"), BizAgentNotFound)
		return
	}
	existingIDs := make(map[string]bool)
	if h.st != nil && h.st.Agents != nil {
		if profiles, err := h.st.Agents.ListProfiles(r.Context()); err == nil {
			for _, p := range profiles {
				existingIDs[p.ID] = true
			}
		}
	}
	newID := tplCp.ID
	if existingIDs[newID] {
		n := 2
		for existingIDs[fmt.Sprintf("%s-%d", tplCp.ID, n)] {
			n++
		}
		newID = fmt.Sprintf("%s-%d", tplCp.ID, n)
	}
	ag := ProtoAgent{
		ID:          newID,
		Name:        tplCp.Name,
		Role:        tplCp.Role,
		Duty:        tplCp.Duty,
		Enabled:     true,
		Runtime:     tplCp.Runtime,
		Model:       tplCp.Model,
		Effort:      tplCp.Effort,
		Persona:     tplCp.Persona,
		PersonaMode: tplCp.PersonaMode,
		Skills:      copyStrings(tplCp.Skills),
		Worktree:    tplCp.Worktree,
		Tags:        copyStrings(tplCp.Tags),
		Look:        tplCp.Look,
		From:        &ProtoAgentFrom{Template: tplCp.ID, Version: tplCp.Version},
	}
	saved, err := h.saveAgentFromProto(r.Context(), ag, true)
	if err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	h.hub.mu.Lock()
	if t := h.hub.state.Templates[req.ID]; t != nil && !slices.Contains(t.Installed, saved.ID) {
		t.Installed = append(t.Installed, saved.ID)
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, saved)
}

func (h *Handler) handleAgentTemplateUpdate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		Agent string `json:"agent"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	p, err := h.st.Agents.GetProfile(r.Context(), req.Agent)
	if err != nil {
		writeError(w, err, BizAgentNotFound)
		return
	}
	h.hub.mu.RLock()
	meta := h.hub.state.Agents[p.ID]
	var tplID string
	if meta != nil && meta.From != nil {
		tplID = meta.From.Template
	}
	h.hub.mu.RUnlock()
	if tplID == "" {
		writeSuccess(w, h.hub.buildProtoAgent(p))
		return
	}
	tplCp, ok := h.findTemplate(r.Context(), tplID)
	if !ok {
		writeError(w, newBizError(BizAgentNotFound, "agent template not found"), BizAgentNotFound)
		return
	}
	cur := h.hub.buildProtoAgent(p)
	cur.Role = tplCp.Role
	cur.Name = tplCp.Name
	cur.Duty = tplCp.Duty
	cur.Tags = copyStrings(tplCp.Tags)
	cur.Runtime = tplCp.Runtime
	cur.Model = tplCp.Model
	cur.Effort = tplCp.Effort
	cur.Persona = tplCp.Persona
	cur.PersonaMode = tplCp.PersonaMode
	cur.Worktree = tplCp.Worktree
	cur.Skills = copyStrings(tplCp.Skills)
	cur.Look = tplCp.Look
	cur.From = &ProtoAgentFrom{Template: tplCp.ID, Version: tplCp.Version}
	saved, sErr := h.saveAgentFromProto(r.Context(), cur, false)
	if sErr != nil {
		writeError(w, sErr, BizAgentRefused)
		return
	}
	writeSuccess(w, saved)
}

func (h *Handler) handleAgentTemplateAdd(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	dir := strings.TrimSpace(req.Path)
	if dir == "" {
		writeError(w, newBizError(BizAgentRefused, "template path is required"), BizAgentRefused)
		return
	}
	tpl, err := readTemplateFolder(dir, "added", h.currentLocale())
	if err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	if root := h.addedTemplatesRoot(); root != "" {
		dstDir := filepath.Join(root, tpl.ID)
		if err := os.MkdirAll(dstDir, 0o755); err == nil {
			for _, fname := range []string{"agent.json", "agent.en.json", "persona.md", "persona.en.md"} {
				src := filepath.Join(dir, fname)
				if data, rErr := os.ReadFile(src); rErr == nil {
					_ = os.WriteFile(filepath.Join(dstDir, fname), data, 0o644)
				}
			}
		}
	}
	h.hub.mu.Lock()
	h.hub.state.Templates[tpl.ID] = &tpl
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, tpl)
}

func (h *Handler) handleAgentTemplateDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, builtIn := findBuiltinStarter(req.ID); builtIn {
		writeError(w, newBizError(BizAgentRefused, "built-in template cannot be deleted"), BizAgentRefused)
		return
	}
	h.hub.mu.Lock()
	tpl, ok := h.hub.state.Templates[req.ID]
	if ok && tpl.Source == "added" {
		delete(h.hub.state.Templates, req.ID)
	}
	h.hub.mu.Unlock()
	if root := h.addedTemplatesRoot(); root != "" {
		dstDir := filepath.Join(root, req.ID)
		if _, statErr := os.Stat(dstDir); statErr == nil {
			ok = true
			_ = os.RemoveAll(dstDir)
		}
	}
	if !ok {
		writeError(w, newBizError(BizAgentNotFound, "template not found"), BizAgentNotFound)
		return
	}
	if tpl != nil && tpl.Source == "builtIn" {
		writeError(w, newBizError(BizAgentRefused, "built-in template cannot be deleted"), BizAgentRefused)
		return
	}
	_ = h.hub.persist()
	writeVoid(w)
}

func (h *Handler) handleAgentTemplatePreviewDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Remove added template %s", req.ID)},
	})
}

type protoSkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Body        string `json:"body"`
	BuiltIn     *bool  `json:"builtIn,omitempty"`
}

func toProtoSkill(sk agent.Skill) protoSkill {
	var bi *bool
	if sk.BuiltIn {
		b := true
		bi = &b
	}
	return protoSkill{
		ID:          sk.ID,
		Name:        firstNonEmpty(sk.Name, sk.ID),
		Description: sk.Description,
		Body:        sk.Content,
		BuiltIn:     bi,
	}
}

func (h *Handler) handleSkillList(w http.ResponseWriter, r *http.Request) {
	skills, err := h.st.Agents.ListSkills(r.Context())
	if err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	out := make([]protoSkill, 0, len(skills))
	for _, sk := range skills {
		h.hub.mu.RLock()
		del := h.hub.state.DeletedSkills[sk.ID]
		h.hub.mu.RUnlock()
		if del {
			continue
		}
		out = append(out, toProtoSkill(sk))
	}
	writeSuccess(w, out)
}

func (h *Handler) handleSkillSave(w http.ResponseWriter, r *http.Request, caller user.Caller, create bool) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req protoSkill
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	id := strings.TrimSpace(req.ID)
	if create && id == "" {
		id = randomID("skill")
	}
	saved, err := h.st.Agents.SaveSkill(r.Context(), agent.Skill{
		ID:          id,
		Name:        firstNonEmpty(req.Name, id),
		Description: req.Description,
		Content:     req.Body,
	})
	if err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	writeSuccess(w, toProtoSkill(saved))
}

func (h *Handler) handleSkillDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := h.st.Agents.DeleteSkill(r.Context(), req.ID); err != nil {
		writeError(w, err, BizAgentRefused)
		return
	}
	h.hub.mu.Lock()
	h.hub.state.DeletedSkills[req.ID] = true
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeVoid(w)
}

func (h *Handler) handleSkillPreviewDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Delete skill %s", req.ID)},
	})
}

func (h *Handler) buildRuntimeInfo(ctx context.Context, rt agent.RuntimeInfo) ProtoRuntimeInfo {
	preset := rt.Preset
	if preset.ID == "" {
		preset = agent.PresetOf(rt.ID)
	}
	sup := rt.Support
	if sup.Refused == nil {
		sup.Refused = map[string]string{}
	}
	caps := copyStrings(sup.Capabilities)
	install := map[string]any{"status": "not_found"}
	if rt.Installed || rt.ID == "vibevalley" {
		install = map[string]any{
			"status":  "available",
			"via":     "bundled",
			"command": rt.ID,
			"version": nil,
		}
	}
	h.hub.mu.RLock()
	ovr := h.hub.state.RuntimeSettings[rt.ID]
	h.hub.mu.RUnlock()

	settings := ProtoRuntimeSettings{
		Enabled:       rt.Settings.Enabled,
		BinPath:       rt.Settings.BinPath,
		DefaultModel:  rt.Settings.DefaultModel,
		DefaultEffort: rt.Settings.DefaultEffort,
		Env:           rt.Settings.Env,
	}
	if settings.Env == nil {
		settings.Env = map[string]string{}
	}
	if rt.Settings.DailyBudget > 0 {
		db := rt.Settings.DailyBudget
		settings.DailyBudget = &db
	}
	if ovr != nil {
		settings = *ovr
		if settings.Env == nil {
			settings.Env = map[string]string{}
		}
	}

	var models []ProtoModelEntry
	if len(rt.Models) > 0 {
		models = make([]ProtoModelEntry, 0, len(rt.Models))
		for _, m := range rt.Models {
			models = append(models, ProtoModelEntry{
				ID:           m.ID,
				Name:         m.Name,
				EffortLevels: copyStrings(m.EffortLevels),
				IsDefault:    m.IsDefault,
			})
		}
	}

	build := firstNonEmpty(preset.Look.Build, "biped")
	head := firstNonEmpty(preset.Look.Head, "rounded")
	return ProtoRuntimeInfo{
		ID: rt.ID,
		Preset: ProtoRuntimePreset{
			ID:    firstNonEmpty(preset.ID, rt.ID),
			Label: firstNonEmpty(preset.Label, rt.ID),
			Blurb: preset.Blurb,
			Look: ProtoLook{
				Species:      nil,
				Outfit:       nil,
				Orchestrator: nil,
				Build:        build,
				Head:         head,
				Body:         firstNonEmpty(preset.Look.Body, "#f3e9da"),
				Trim:         firstNonEmpty(preset.Look.Trim, "#4f9a5a"),
				Hat:          firstNonEmpty(preset.Look.Hat, "#e8804f"),
				Eye:          firstNonEmpty(preset.Look.Eye, "#a6f4ff"),
			},
		},
		Support: ProtoRuntimeSupport{
			Steer:        sup.Steer,
			Refused:      sup.Refused,
			Capabilities: caps,
			InProcess:    sup.InProcess,
		},
		Installation: install,
		Models:       models,
		Usage:        nil,
		Skills:       nil,
		MCPServers:   nil,
		Tools:        nil,
		Settings:     settings,
		Stop:         "",
		CheckedAt:    h.hub.nowMs(),
	}
}

func (h *Handler) handleRuntimeList(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Agents.ListRuntimes(r.Context())
	if err != nil {
		writeError(w, err, BizRuntimeRefused)
		return
	}
	out := make([]ProtoRuntimeInfo, 0, len(list))
	for _, rt := range list {
		out = append(out, h.buildRuntimeInfo(r.Context(), rt))
	}
	writeSuccess(w, out)
}

func (h *Handler) handleRuntimeRefresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	rt, err := h.st.Agents.GetRuntimeInfo(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizRuntimeNotFound)
		return
	}
	writeSuccess(w, h.buildRuntimeInfo(r.Context(), rt))
}

func (h *Handler) handleRuntimeSettingUpdate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
		ProtoRuntimeSettings
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	rt, err := h.st.Agents.GetRuntimeInfo(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizRuntimeNotFound)
		return
	}
	cp := req.ProtoRuntimeSettings
	if cp.Env == nil {
		cp.Env = map[string]string{}
	}
	rt.Settings = agent.RuntimeSettings{
		Enabled:       cp.Enabled,
		BinPath:       cp.BinPath,
		DefaultModel:  cp.DefaultModel,
		DefaultEffort: cp.DefaultEffort,
		Env:           cp.Env,
	}
	if cp.DailyBudget != nil {
		rt.Settings.DailyBudget = *cp.DailyBudget
	}
	updated, err := h.st.Agents.SetRuntimeInfo(r.Context(), rt)
	if err != nil {
		writeError(w, err, BizRuntimeRefused)
		return
	}
	h.hub.mu.Lock()
	h.hub.state.RuntimeSettings[req.ID] = &cp
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, h.buildRuntimeInfo(r.Context(), updated))
}

func (h *Handler) handleIssueCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title        string                 `json:"title"`
		Parent       string                 `json:"parent"`
		BlockedBy    []string               `json:"blockedBy"`
		Constraints  *ProtoIssueConstraints `json:"constraints"`
		Description  string                 `json:"description"`
		Repo         string                 `json:"repo"`
		Agent        string                 `json:"agent"`
		Priority     string                 `json:"priority"`
		Deliver      string                 `json:"deliver"`
		AutoSubmitPR *bool                  `json:"autoSubmitPr"`
		Criteria     []string               `json:"criteria"`
		RequestKey   string                 `json:"requestKey"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := checkRequestKeyLength(req.RequestKey); err != nil {
		writeError(w, err, BizRequestKeyTooLong)
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		writeError(w, newBizError(BizInvalidInput, "issue title is required"), BizInvalidInput)
		return
	}

	if req.RequestKey != "" {
		h.hub.mu.RLock()
		existingID := h.hub.state.RequestKeys["issue.create:"+req.RequestKey]
		h.hub.mu.RUnlock()
		if existingID != "" {
			if iss, err := h.st.Issues.GetIssue(r.Context(), existingID); err == nil {
				writeSuccess(w, ProtoAppliedIssue{ProtoIssue: h.hub.buildProtoIssue(iss), Seq: h.st.StateSeq()})
				return
			}
		}
	}

	id := randomID("issue")
	var rubric *contract.RubricSpec
	if len(req.Criteria) > 0 {
		var lines []string
		for _, c := range req.Criteria {
			lines = append(lines, "- "+c)
		}
		rubric = &contract.RubricSpec{Markdown: strings.Join(lines, "\n")}
	}

	created, err := h.st.Issues.CreateIssue(r.Context(), issue.Issue{
		ID:          id,
		Title:       strings.TrimSpace(req.Title),
		Description: req.Description,
		Prompt:      req.Description,
		Status:      contract.IssueDraft,
		RepoID:      req.Repo,
		AssigneeID:  req.Agent,
		Rubric:      rubric,
	})
	if err != nil {
		writeError(w, err, BizIssueRefused)
		return
	}

	nowMs := h.hub.nowMs()
	h.hub.mu.Lock()
	meta := h.hub.ensureIssueMetaLocked(created.ID)
	meta.Parent = req.Parent
	meta.BlockedBy = copyStrings(req.BlockedBy)
	if req.Priority != "" {
		meta.Priority = req.Priority
	}
	if req.Deliver != "" {
		meta.Deliver = req.Deliver
	}
	if req.AutoSubmitPR != nil {
		meta.AutoSubmitPR = *req.AutoSubmitPR
	}
	meta.Criteria = copyStrings(req.Criteria)
	meta.Constraints = req.Constraints
	meta.AgentHint = req.Agent
	meta.Moves = []string{"backlog"}
	meta.Milestones = append(meta.Milestones, ProtoMilestone{
		At:   nowMs,
		Kind: "opened",
		Text: created.Title,
	})
	if req.RequestKey != "" {
		h.hub.state.RequestKeys["issue.create:"+req.RequestKey] = created.ID
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())
	seq := h.st.StateSeq()
	dto := h.hub.buildProtoIssue(created)
	h.hub.emitServerEvent(map[string]any{
		"type":  "issueChanged",
		"at":    nowMs,
		"issue": dto,
	})
	writeSuccess(w, ProtoAppliedIssue{ProtoIssue: dto, Seq: seq})
}

func (h *Handler) handleIssueGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	iss, err := h.st.Issues.GetIssue(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	h.hub.mu.RLock()
	del := h.hub.state.Issues[iss.ID] != nil && h.hub.state.Issues[iss.ID].Deleted
	h.hub.mu.RUnlock()
	if del {
		writeError(w, newBizError(BizIssueNotFound, "issue not found"), BizIssueNotFound)
		return
	}
	writeSuccess(w, h.hub.buildProtoIssue(iss))
}

func (h *Handler) handleIssueList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Status    string `json:"status"`
		Text      string `json:"text"`
		Repo      string `json:"repo"`
		Limit     *int   `json:"limit"`
		Closed    *bool  `json:"closed"`
		WantsUser *bool  `json:"wantsUser"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	all, err := h.st.Issues.ListIssues(r.Context())
	if err != nil {
		writeError(w, err, BizIssueRefused)
		return
	}
	out := make([]ProtoIssue, 0, len(all))
	qText := strings.ToLower(strings.TrimSpace(req.Text))
	for _, iss := range all {
		h.hub.mu.RLock()
		del := h.hub.state.Issues[iss.ID] != nil && h.hub.state.Issues[iss.ID].Deleted
		h.hub.mu.RUnlock()
		if del {
			continue
		}
		dto := h.hub.buildProtoIssue(iss)
		if req.Status != "" {
			if dto.Status != req.Status {
				continue
			}
		} else if req.Closed != nil {
			isClosed := dto.Status == "done" || dto.Status == "canceled"
			if *req.Closed != isClosed {
				continue
			}
		} else {
			if dto.Status == "done" || dto.Status == "canceled" {
				continue
			}
		}
		if req.Repo != "" && dto.Repo != req.Repo {
			continue
		}
		if qText != "" && !strings.Contains(strings.ToLower(dto.Title+" "+dto.Description), qText) {
			continue
		}
		if req.WantsUser != nil && *req.WantsUser {
			st := dto.Stage.State
			if st != "asking" && st != "reviewing" && st != "stuck" {
				continue
			}
		}
		out = append(out, dto)
	}
	if req.WantsUser != nil && *req.WantsUser {
		nowMs := h.hub.nowMs()
		sort.SliceStable(out, func(i, j int) bool {
			si, sj := nowMs, nowMs
			if out[i].Stage.Since != nil {
				si = *out[i].Stage.Since
			}
			if out[j].Stage.Since != nil {
				sj = *out[j].Stage.Since
			}
			return si < sj
		})
	} else {
		sortProtoIssuesOrder(out)
	}
	if req.Limit != nil && *req.Limit > 0 && len(out) > *req.Limit {
		out = out[:*req.Limit]
	}
	writeSuccess(w, out)
}

type issueEditPayload struct {
	Title       *string  `json:"title"`
	Description *string  `json:"description"`
	Repo        *string  `json:"repo"`
	Agent       *string  `json:"agent"`
	Priority    *string  `json:"priority"`
	Criteria    []string `json:"criteria"`
	Deliver     *string  `json:"deliver"`
	Before      *string  `json:"before"`
}

func (h *Handler) applyIssueUpdate(ctx context.Context, id string, edit issueEditPayload) (issue.Issue, error) {
	iss, err := h.st.Issues.GetIssue(ctx, id)
	if err != nil {
		return issue.Issue{}, err
	}
	h.hub.mu.Lock()
	defer h.hub.mu.Unlock()
	if m := h.hub.state.Issues[id]; m != nil && m.Deleted {
		return issue.Issue{}, issue.ErrNotFound
	}
	meta := h.hub.ensureIssueMetaLocked(id)

	var updatedTitle, updatedDesc, updatedRepo, updatedAgent string
	updatedTitle = iss.Title
	updatedDesc = firstNonEmpty(iss.Description, iss.Prompt)
	updatedRepo = iss.RepoID
	updatedAgent = iss.AssigneeID

	if edit.Title != nil {
		updatedTitle = strings.TrimSpace(*edit.Title)
	}
	if edit.Description != nil {
		updatedDesc = *edit.Description
	}
	if edit.Repo != nil {
		updatedRepo = *edit.Repo
	}
	if edit.Agent != nil {
		updatedAgent = *edit.Agent
		meta.AgentHint = *edit.Agent
	}
	if edit.Priority != nil {
		meta.Priority = *edit.Priority
	}
	if edit.Criteria != nil {
		meta.Criteria = copyStrings(edit.Criteria)
	}
	if edit.Deliver != nil {
		meta.Deliver = *edit.Deliver
	}

	// Persist field updates directly to issue.Service.
	updated, err := h.st.Issues.UpdateIssue(ctx, id, func(cur *issue.Issue) error {
		cur.Title = updatedTitle
		cur.Description = updatedDesc
		cur.Prompt = updatedDesc
		cur.RepoID = updatedRepo
		cur.AssigneeID = updatedAgent
		return nil
	})
	if err != nil {
		return issue.Issue{}, err
	}
	if edit.Before != nil {
		h.placeIssueLocked(ctx, id, strings.TrimSpace(*edit.Before))
	}
	return updated, nil
}

func (h *Handler) handleIssueUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
		issueEditPayload
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	iss, err := h.applyIssueUpdate(r.Context(), req.ID, req.issueEditPayload)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())
	seq := h.st.StateSeq()
	dto := h.hub.buildProtoIssue(iss)
	dto.Title = iss.Title
	dto.Description = firstNonEmpty(iss.Description, iss.Prompt)
	dto.Repo = iss.RepoID
	h.hub.emitServerEvent(map[string]any{
		"type":  "issueChanged",
		"at":    h.hub.nowMs(),
		"issue": dto,
	})
	writeSuccess(w, ProtoAppliedIssue{ProtoIssue: dto, Seq: seq})
}

func (h *Handler) handleIssueDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetIssue(r.Context(), req.ID); err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureIssueMetaLocked(req.ID)
	meta.Deleted = true
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())
	h.hub.emitServerEvent(map[string]any{
		"type": "issueRemoved",
		"at":   h.hub.nowMs(),
		"id":   req.ID,
	})
	writeVoid(w)
}

func (h *Handler) handleIssuePreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetIssue(r.Context(), req.ID); err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Delete issue %s", req.ID)},
	})
}

func (h *Handler) handleIssueStatusUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string            `json:"id"`
		Status     string            `json:"status"`
		Text       string            `json:"text"`
		Agent      string            `json:"agent"`
		Edit       *issueEditPayload `json:"edit"`
		RequestKey string            `json:"requestKey"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := checkRequestKeyLength(req.RequestKey); err != nil {
		writeError(w, err, BizRequestKeyTooLong)
		return
	}
	if req.RequestKey != "" {
		h.hub.mu.RLock()
		seenKey := h.hub.state.RequestKeys["issue.status:"+req.RequestKey]
		h.hub.mu.RUnlock()
		if seenKey != "" {
			if iss, err := h.st.Issues.GetIssue(r.Context(), req.ID); err == nil {
				writeSuccess(w, ProtoAppliedIssue{ProtoIssue: h.hub.buildProtoIssue(iss), Seq: h.st.StateSeq()})
				return
			}
		}
	}
	if req.Edit != nil {
		if _, err := h.applyIssueUpdate(r.Context(), req.ID, *req.Edit); err != nil {
			writeError(w, err, BizIssueNotFound)
			return
		}
	}
	iss, err := h.st.Issues.GetIssue(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	targetContract := mapContractIssueStatus(req.Status)
	nowMs := h.hub.nowMs()

	h.hub.mu.RLock()
	preMeta := h.hub.state.Issues[req.ID]
	hadWorker := iss.SessionID != "" || (preMeta != nil && len(preMeta.AgentHistory) > 0)
	deliver := "change"
	if preMeta != nil && preMeta.Deliver != "" {
		deliver = preMeta.Deliver
	}
	h.hub.mu.RUnlock()

	if req.Status == "todo" && iss.Status == contract.IssueDraft {
		updated, _, qErr := h.st.Issues.QueueAndDispatch(r.Context(), req.ID)
		if qErr == nil {
			iss = updated
			if req.Agent != "" {
				if upd, uErr := h.st.Issues.UpdateIssue(r.Context(), req.ID, func(cur *issue.Issue) error {
					cur.AssigneeID = req.Agent
					return nil
				}); uErr == nil {
					iss = upd
				}
			}
		} else if upd, uErr := h.st.Issues.UpdateIssue(r.Context(), req.ID, func(cur *issue.Issue) error {
			cur.Status = targetContract
			if req.Agent != "" {
				cur.AssigneeID = req.Agent
			}
			return nil
		}); uErr == nil {
			iss = upd
		}
	} else if upd, uErr := h.st.Issues.UpdateIssue(r.Context(), req.ID, func(cur *issue.Issue) error {
		cur.Status = targetContract
		if req.Status == "todo" {
			cur.FailureReason = ""
		}
		if req.Agent != "" {
			cur.AssigneeID = req.Agent
		}
		return nil
	}); uErr == nil {
		iss = upd
	}

	h.hub.mu.Lock()
	meta := h.hub.ensureIssueMetaLocked(req.ID)
	if req.Agent != "" {
		meta.AgentHint = req.Agent
	}
	if req.Status == "todo" {
		if meta.QueuedAt == nil {
			meta.QueuedAt = &nowMs
		}
		meta.ClosedAt = nil
		meta.Delivered = ""
		meta.Canceled = ""
		meta.Questions = nil
		meta.Conflict = nil
		meta.LastRunOutcome = ""
		if req.Text != "" && (iss.Status == contract.IssueReview || preMeta != nil && len(preMeta.Runs) > 0) {
			meta.Findings = append(meta.Findings, ProtoFinding{
				ID:       fmt.Sprintf("f-%d", nowMs),
				Text:     req.Text,
				At:       nowMs,
				Resolved: false,
			})
		}
		meta.Milestones = append(meta.Milestones, ProtoMilestone{
			At:   nowMs,
			Kind: "started",
			Text: firstNonEmpty(req.Text, req.Status),
		})
	} else if req.Status == "done" {
		meta.ClosedAt = &nowMs
		meta.Canceled = ""
		if deliver == "answer" {
			meta.Delivered = "kept"
		} else if iss.PRURL != "" {
			meta.Delivered = "pull_request"
		} else if deliver == "branch" {
			meta.Delivered = "kept"
		} else {
			meta.Delivered = "kept"
		}
		meta.Milestones = append(meta.Milestones, ProtoMilestone{
			At:   nowMs,
			Kind: "accepted",
			Text: firstNonEmpty(req.Text, "done"),
		})
	} else if req.Status == "canceled" {
		meta.ClosedAt = &nowMs
		meta.Canceled = "dismissed"
		meta.Milestones = append(meta.Milestones, ProtoMilestone{
			At:   nowMs,
			Kind: "closed",
			Text: firstNonEmpty(req.Text, "canceled"),
		})
	}
	if req.RequestKey != "" {
		h.hub.state.RequestKeys["issue.status:"+req.RequestKey] = req.ID
	}
	h.hub.mu.Unlock()

	if req.Status == "done" && deliver != "branch" && deliver != "pull_request" && deliver != "answer" && iss.RepoID != "" && h.st != nil && h.st.Repos != nil {
		if rp, rErr := h.findRepoByIDOrName(r.Context(), iss.RepoID); rErr == nil {
			if _, wtErr := h.st.Repos.GetWorktree(r.Context(), rp.ID, iss.ID); wtErr == nil {
				if mRes, mErr := h.st.Repos.MergeWorktree(r.Context(), rp.ID, iss.ID); mErr == nil && mRes.Merged {
					h.hub.mu.Lock()
					m := h.hub.ensureIssueMetaLocked(iss.ID)
					m.Delivered = "merged"
					m.WorktreePath = ""
					h.hub.mu.Unlock()
				}
			}
		}
	}
	if req.Status == "done" || req.Status == "canceled" {
		h.hub.mu.Lock()
		closedReason := "completed"
		if req.Status == "canceled" {
			closedReason = "dismissed"
		} else if m := h.hub.state.Issues[iss.ID]; m != nil && m.Delivered == "merged" {
			closedReason = "merged"
		}
		for _, s := range h.hub.state.Sessions {
			if s != nil && s.Scope != nil && s.Scope.Kind == "issue" && s.Scope.ID == iss.ID {
				s.Phase = ProtoPhase{Tag: "closed", At: &nowMs, Closed: closedReason}
			}
		}
		h.hub.mu.Unlock()
	}

	if req.Status == "todo" {
		iss = h.dispatchScriptedWorker(r.Context(), iss, "issue", req.Text, !hadWorker)
	}

	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())

	dto := h.hub.buildProtoIssue(iss)
	seq := h.st.StateSeq()
	h.hub.emitServerEvent(map[string]any{
		"type":  "issueChanged",
		"at":    nowMs,
		"issue": dto,
	})
	writeSuccess(w, ProtoAppliedIssue{ProtoIssue: dto, Seq: seq})
}

func (h *Handler) handleIssueStatusPreviewUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetIssue(r.Context(), req.ID); err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Move issue %s to %s", req.ID, req.Status)},
	})
}

func (h *Handler) handleIssueReview(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID       string   `json:"id"`
		Pass     bool     `json:"pass"`
		Findings []string `json:"findings"`
		Text     string   `json:"text"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	iss, err := h.st.Issues.GetIssue(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	nowMs := h.hub.nowMs()
	h.hub.mu.Lock()
	meta := h.hub.ensureIssueMetaLocked(req.ID)
	meta.ReviewedAt = &nowMs
	for i, f := range req.Findings {
		meta.Findings = append(meta.Findings, ProtoFinding{
			ID:       fmt.Sprintf("f-%d-%d", nowMs, i),
			Text:     f,
			At:       nowMs,
			Resolved: req.Pass,
		})
	}
	kind := "accepted"
	if !req.Pass {
		kind = "rejected"
	}
	meta.Milestones = append(meta.Milestones, ProtoMilestone{
		At:   nowMs,
		Kind: kind,
		Text: firstNonEmpty(req.Text, kind),
	})
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())
	writeSuccess(w, h.hub.buildProtoIssue(iss))
}

func (h *Handler) handleIssueRefine(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   string            `json:"id"`
		Text string            `json:"text"`
		Edit *issueEditPayload `json:"edit"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if req.Edit != nil {
		if _, err := h.applyIssueUpdate(r.Context(), req.ID, *req.Edit); err != nil {
			writeError(w, err, BizIssueNotFound)
			return
		}
	}
	iss, err := h.st.Issues.GetIssue(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	if os.Getenv("VIBEVALLEY_TEST_RUNTIMES") == "1" {
		if refined, rErr := h.runScriptedRefine(r.Context(), iss, req.Text); rErr == nil {
			writeSuccess(w, h.hub.buildProtoIssue(refined))
			return
		}
	}
	nowMs := h.hub.nowMs()
	h.hub.mu.Lock()
	meta := h.hub.ensureIssueMetaLocked(req.ID)
	meta.Milestones = append(meta.Milestones, ProtoMilestone{
		At:   nowMs,
		Kind: "refined",
		Text: firstNonEmpty(req.Text, iss.Title),
	})
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, h.hub.buildProtoIssue(iss))
}

func (h *Handler) handleIssueSplit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Tasks []struct {
			ID         string   `json:"id"`
			Title      string   `json:"title"`
			Brief      string   `json:"brief"`
			Needs      []string `json:"needs"`
			Agent      string   `json:"agent"`
			Check      string   `json:"check"`
			Scope      []string `json:"scope"`
			Acceptance *bool    `json:"acceptance"`
		} `json:"tasks"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	parent, err := h.st.Issues.GetIssue(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	h.hub.mu.RLock()
	parentMeta := h.hub.state.Issues[parent.ID]
	parentPriority := "medium"
	if parentMeta != nil && parentMeta.Priority != "" {
		parentPriority = parentMeta.Priority
	}
	h.hub.mu.RUnlock()

	nowMs := h.hub.nowMs()
	draftToChild := make(map[string]string, len(req.Tasks))
	childIDs := make([]string, len(req.Tasks))
	for i, t := range req.Tasks {
		cid := randomID("issue")
		childIDs[i] = cid
		if t.ID != "" {
			draftToChild[t.ID] = cid
		}
	}
	var createdChildren []issue.Issue
	for i, t := range req.Tasks {
		childID := childIDs[i]
		title := firstNonEmpty(t.Title, t.Brief, t.ID)
		desc := ""
		if t.Title != "" {
			desc = t.Brief
		}
		assignee := strings.TrimSpace(t.Agent)
		if assignee == "" {
			assignee = parent.AssigneeID
		}
		var blockedBy []string
		for _, dep := range t.Needs {
			if targetID, ok := draftToChild[dep]; ok {
				blockedBy = append(blockedBy, targetID)
			}
		}
		scope := t.Scope
		if scope == nil {
			scope = []string{}
		}
		constraints := &ProtoIssueConstraints{
			Check:      strings.TrimSpace(t.Check),
			Scope:      scope,
			Acceptance: t.Acceptance != nil && *t.Acceptance,
			Frozen:     []string{},
		}
		cIss, cErr := h.st.Issues.CreateIssue(r.Context(), issue.Issue{
			ID:          childID,
			Title:       title,
			Description: desc,
			Prompt:      firstNonEmpty(t.Brief, title),
			RepoID:      parent.RepoID,
			AssigneeID:  assignee,
			Status:      contract.IssueQueued,
		})
		if cErr != nil {
			continue
		}
		h.hub.mu.Lock()
		cm := h.hub.ensureIssueMetaLocked(childID)
		cm.Parent = parent.ID
		cm.Priority = parentPriority
		cm.BlockedBy = blockedBy
		cm.Constraints = constraints
		cm.QueuedAt = &nowMs
		cm.AgentHint = assignee
		cm.Milestones = append(cm.Milestones, ProtoMilestone{At: nowMs, Kind: "opened", Text: title})
		h.hub.mu.Unlock()
		createdChildren = append(createdChildren, cIss)
	}
	if len(createdChildren) > 0 {
		_, _ = h.st.Issues.UpdateIssue(r.Context(), parent.ID, func(cur *issue.Issue) error {
			if cur.Status == contract.IssueDraft || cur.Status == contract.IssueQueued {
				cur.Status = contract.IssueInProgress
			}
			return nil
		})
		for i, ch := range createdChildren {
			if len(req.Tasks[i].Needs) == 0 {
				h.dispatchScriptedWorker(r.Context(), ch, "issue", "", true)
			}
		}
	}
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())
	writeSuccess(w, fmt.Sprintf("split %s into %d child issues", parent.ID, len(req.Tasks)))
}

func (h *Handler) handleIssueConversationGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetIssue(r.Context(), req.ID); err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	chID, ok := h.findIssueThreadChannel(r.Context(), req.ID)
	if !ok || strings.TrimSpace(chID) == "" {
		writeSuccess(w, nil)
		return
	}
	writeSuccess(w, chID)
}

func (h *Handler) handleIssueCommentCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		Text    string `json:"text"`
		SendKey string `json:"sendKey"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	iss, err := h.st.Issues.GetIssue(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	if req.SendKey != "" {
		h.hub.mu.RLock()
		seenKey := h.hub.state.RequestKeys["issue.comment:"+req.ID+":"+req.SendKey]
		h.hub.mu.RUnlock()
		if seenKey != "" {
			writeSuccess(w, map[string]any{"seq": h.st.StateSeq()})
			return
		}
	}
	nowMs := h.hub.nowMs()
	h.hub.mu.Lock()
	meta := h.hub.ensureIssueMetaLocked(req.ID)
	meta.Milestones = append(meta.Milestones, ProtoMilestone{
		At:   nowMs,
		Kind: "told",
		Text: req.Text,
	})
	if req.SendKey != "" {
		h.hub.state.RequestKeys["issue.comment:"+req.ID+":"+req.SendKey] = "ok"
	}
	h.hub.mu.Unlock()

	if os.Getenv("VIBEVALLEY_TEST_RUNTIMES") == "1" {
		h.dispatchScriptedWorker(r.Context(), iss, "comment", req.Text, false)
	}
	_ = h.hub.persist()
	seq := h.st.NotifyStateChange()
	writeSuccess(w, map[string]any{"seq": seq})
}

func (h *Handler) handleIssueDiffGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	iss, err := h.st.Issues.GetIssue(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	writeSuccess(w, h.computeIssueDiff(r.Context(), iss))
}

func (h *Handler) handleIssueHistoryList(w http.ResponseWriter, r *http.Request) {
	issues, err := h.st.Issues.ListIssues(r.Context())
	if err != nil {
		writeError(w, err, BizIssueRefused)
		return
	}
	dtos := make([]ProtoIssue, 0, len(issues))
	for _, iss := range issues {
		h.hub.mu.RLock()
		del := h.hub.state.Issues[iss.ID] != nil && h.hub.state.Issues[iss.ID].Deleted
		h.hub.mu.RUnlock()
		if del {
			continue
		}
		dtos = append(dtos, h.hub.buildProtoIssue(iss))
	}
	sortProtoIssuesOrder(dtos)

	out := make([]map[string]any, 0, len(dtos))
	h.hub.mu.RLock()
	for _, dto := range dtos {
		sessions := []ProtoSession{}
		missing := []string{}
		seen := map[string]bool{}
		for _, a := range dto.Assignments {
			for _, ex := range a.Executions {
				if ex.Kind != "worker" || ex.Session == "" || seen[ex.Session] {
					continue
				}
				seen[ex.Session] = true
				if s := h.hub.state.Sessions[ex.Session]; s != nil {
					sessions = append(sessions, *s)
				} else {
					missing = append(missing, ex.Session)
				}
			}
		}
		out = append(out, map[string]any{
			"issue":           dto,
			"sessions":        sessions,
			"missingSessions": missing,
		})
	}
	h.hub.mu.RUnlock()
	writeSuccess(w, out)
}

func (h *Handler) handleIssueRunList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetIssue(r.Context(), req.ID); err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	h.hub.mu.RLock()
	meta := h.hub.state.Issues[req.ID]
	var runs []ProtoRun
	if meta != nil && len(meta.Runs) > 0 {
		runs = append([]ProtoRun{}, meta.Runs...)
	} else {
		runs = []ProtoRun{}
	}
	h.hub.mu.RUnlock()
	writeSuccess(w, runs)
}

func (h *Handler) handleIssueTimelineGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetIssue(r.Context(), req.ID); err != nil {
		writeError(w, err, BizIssueNotFound)
		return
	}
	h.hub.mu.RLock()
	meta := h.hub.state.Issues[req.ID]
	milestones := []ProtoMilestone{}
	if meta != nil && len(meta.Milestones) > 0 {
		milestones = append([]ProtoMilestone{}, meta.Milestones...)
	}
	h.hub.mu.RUnlock()
	writeSuccess(w, map[string]any{
		"milestones": milestones,
	})
}

func (h *Handler) handleSessionList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.RLock()
	out := make([]ProtoSession, 0, len(h.hub.state.Sessions))
	for _, s := range h.hub.state.Sessions {
		if s == nil {
			continue
		}
		if req.Agent != "" && s.Agent != req.Agent {
			continue
		}
		out = append(out, *s)
	}
	h.hub.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	writeSuccess(w, out)
}

func (h *Handler) handleSessionGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.RLock()
	s, ok := h.hub.state.Sessions[req.ID]
	h.hub.mu.RUnlock()
	if !ok || s == nil {
		writeError(w, newBizError(BizSessionNotFound, "session not found"), BizSessionNotFound)
		return
	}
	writeSuccess(w, *s)
}

func (h *Handler) handleSessionStop(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.Lock()
	s, ok := h.hub.state.Sessions[req.ID]
	if ok && s != nil {
		s.Phase = ProtoPhase{Tag: "resting"}
	}
	h.hub.mu.Unlock()
	if !ok {
		writeError(w, newBizError(BizSessionNotFound, "session not found"), BizSessionNotFound)
		return
	}
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleSessionEventList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID  string `json:"id"`
		Run string `json:"run"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.RLock()
	_, sessExists := h.hub.state.Sessions[req.ID]
	evs := h.hub.state.SessionEvents[req.ID]
	h.hub.mu.RUnlock()
	if !sessExists {
		if h.st == nil || h.st.Agents == nil {
			writeError(w, newBizError(BizSessionNotFound, "session not found"), BizSessionNotFound)
			return
		}
		if _, err := h.st.Agents.GetProfile(r.Context(), req.ID); err != nil {
			writeError(w, newBizError(BizSessionNotFound, "session not found"), BizSessionNotFound)
			return
		}
	}
	out := []ProtoSessionEvent{}
	for _, ev := range evs {
		if req.Run != "" && ev.Run != req.Run {
			continue
		}
		out = append(out, ev)
	}
	writeSuccess(w, out)
}

func applyCronWhen(raw json.RawMessage, sched *issue.CronSchedule) {
	var w struct {
		Kind    string `json:"kind"`
		Expr    string `json:"expr"`
		Minutes int    `json:"minutes"`
		Time    string `json:"time"`
		At      int64  `json:"at"`
		Days    []int  `json:"days"`
	}
	if err := json.Unmarshal(raw, &w); err != nil {
		return
	}
	switch w.Kind {
	case "once":
		sched.Kind = issue.CronOnce
		sched.AtMs = w.At
	case "every":
		sched.Kind = issue.CronEvery
		sched.EveryMinutes = w.Minutes
	case "daily":
		sched.Kind = issue.CronDaily
		sched.TimeOfDay = w.Time
	case "weekly":
		sched.Kind = issue.CronWeekly
		sched.Weekdays = w.Days
		sched.TimeOfDay = w.Time
	case "cron":
		sched.Kind = issue.CronExpr
		sched.Expr = strings.TrimSpace(w.Expr)
	}
}

func (h *Handler) handleCronCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name    string          `json:"name"`
		Text    string          `json:"text"`
		Channel string          `json:"channel"`
		Agent   string          `json:"agent"`
		Repo    string          `json:"repo"`
		When    json.RawMessage `json:"when"`
		TZ      string          `json:"tz"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	id := randomID("cron")
	tz := firstNonEmpty(req.TZ, "UTC")
	chName := firstNonEmpty(req.Channel, defaultChannelID)
	schedIn := issue.CronSchedule{
		ID:         id,
		Name:       firstNonEmpty(req.Name, id),
		ChannelID:  chName,
		RepoID:     req.Repo,
		AssigneeID: req.Agent,
		Title:      firstNonEmpty(req.Name, id),
		Prompt:     req.Text,
		Timezone:   tz,
		Enabled:    true,
	}
	applyCronWhen(req.When, &schedIn)
	sched, err := h.st.Issues.CreateCron(r.Context(), schedIn)
	if err != nil {
		writeError(w, err, BizCronRefused)
		return
	}
	h.hub.mu.Lock()
	h.hub.state.Crons[sched.ID] = &cronOverlay{
		Channel: chName,
		Agent:   req.Agent,
		Repo:    req.Repo,
		TZ:      tz,
		By:      "user",
		When:    req.When,
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()

	out := ProtoCron{
		ID:      sched.ID,
		Name:    sched.Name,
		Text:    sched.Prompt,
		Channel: chName,
		Agent:   req.Agent,
		Repo:    req.Repo,
		When:    req.When,
		TZ:      tz,
		Enabled: sched.Enabled,
		Created: h.hub.nowMs(),
		By:      "user",
		Pending: false,
	}
	h.hub.emitServerEvent(map[string]any{
		"type": "cronChanged",
		"at":   h.hub.nowMs(),
		"cron": out,
	})
	writeSuccess(w, out)
}

func (h *Handler) handleCronList(w http.ResponseWriter, r *http.Request) {
	crons, err := h.st.Issues.ListCrons(r.Context())
	if err != nil {
		writeError(w, err, BizCronRefused)
		return
	}
	out := make([]ProtoCron, 0, len(crons))
	for _, c := range crons {
		h.hub.mu.RLock()
		cm := h.hub.state.Crons[c.ID]
		h.hub.mu.RUnlock()
		if cm != nil && cm.Deleted {
			continue
		}
		var lastRun *int64
		if c.LastRunAtMs > 0 {
			lr := c.LastRunAtMs
			lastRun = &lr
		}
		when := json.RawMessage(fmt.Sprintf(`{"kind":"cron","expr":%q}`, c.Expr))
		chName := defaultChannelID
		tz := "UTC"
		var agentID, repoID string
		if cm != nil {
			if len(cm.When) > 0 {
				when = cm.When
			}
			chName = firstNonEmpty(cm.Channel, chName)
			tz = firstNonEmpty(cm.TZ, tz)
			agentID = cm.Agent
			repoID = cm.Repo
		}
		out = append(out, ProtoCron{
			ID:      c.ID,
			Name:    firstNonEmpty(c.Name, c.ID),
			Text:    c.Prompt,
			Channel: chName,
			Agent:   agentID,
			Repo:    repoID,
			When:    when,
			TZ:      tz,
			Enabled: c.Enabled,
			Created: c.NextRunAtMs,
			LastRun: lastRun,
			By:      "user",
			Pending: false,
		})
	}
	writeSuccess(w, out)
}

func (h *Handler) handleCronUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		Enabled *bool  `json:"enabled"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if req.Enabled != nil {
		if _, err := h.st.Issues.SetCronEnabled(r.Context(), req.ID, *req.Enabled); err != nil {
			writeError(w, err, BizCronNotFound)
			return
		}
	}
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleCronDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetCron(r.Context(), req.ID); err != nil {
		writeError(w, err, BizCronNotFound)
		return
	}
	_, _ = h.st.Issues.SetCronEnabled(r.Context(), req.ID, false)
	h.hub.mu.Lock()
	cm := h.hub.state.Crons[req.ID]
	if cm == nil {
		cm = &cronOverlay{Channel: defaultChannelID, TZ: "UTC", By: "user"}
		h.hub.state.Crons[req.ID] = cm
	}
	cm.Deleted = true
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	h.hub.emitServerEvent(map[string]any{
		"type": "cronRemoved",
		"at":   h.hub.nowMs(),
		"id":   req.ID,
	})
	writeVoid(w)
}

func (h *Handler) handleCronPreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, err := h.st.Issues.GetCron(r.Context(), req.ID); err != nil {
		writeError(w, err, BizCronNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Delete scheduled task %s", req.ID)},
	})
}

func (h *Handler) handleOrchestratorOpen(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Orchestrator == nil {
		writeError(w, newBizError(BizOrchestratorNotFound, "orchestrator unavailable"), BizOrchestratorNotFound)
		return
	}
	if _, err := h.st.Orchestrator.Open(r.Context(), stack.OpenOptions{}); err != nil {
		writeError(w, err, BizOrchestratorRefused)
		return
	}
	writeVoid(w)
}

func (h *Handler) handleOrchestratorStop(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if h.st != nil && h.st.Orchestrator != nil {
		_ = h.st.Orchestrator.Stop(r.Context(), "")
	}
	writeVoid(w)
}

func (h *Handler) handleOrchestratorEvalCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
		On    int64  `json:"on"`
		Want  string `json:"want"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	agentID := firstNonEmpty(req.Agent, "orchestrator")
	h.hub.mu.RLock()
	evs := h.hub.state.SessionEvents[agentID]
	var targetRun string
	found := false
	for _, ev := range evs {
		if ev.Seq == req.On && ev.Type == "user/message" {
			found = true
			targetRun = ev.Run
			break
		}
	}
	failed := targetRun == "" || h.hub.state.FailedRuns[targetRun]
	hasAnswer := false
	if found && targetRun != "" {
		for _, ev := range evs {
			if ev.Run == targetRun && ev.Type == "assistant/message" {
				hasAnswer = true
				break
			}
		}
	}
	h.hub.mu.RUnlock()
	if !found || failed || !hasAnswer {
		writeError(w, newBizError(BizOrchestratorRefused, "cannot evaluate a round that did not complete a model turn"), BizOrchestratorRefused)
		return
	}
	id := randomID("eval")
	evalDir := filepath.Join(h.st.WorkRoot(), "evals")
	_ = os.MkdirAll(evalDir, 0o755)
	filePath := filepath.Join(evalDir, id+".json")
	raw, _ := json.MarshalIndent(req, "", "  ")
	_ = os.WriteFile(filePath, raw, 0o644)
	writeSuccess(w, map[string]string{
		"id":   id,
		"file": filePath,
	})
}

func (h *Handler) handleGameAchievementList(w http.ResponseWriter, _ *http.Request) {
	writeSuccess(w, []map[string]any{
		{
			"id":       "first-harvest",
			"category": "harvest",
			"title":    "First Harvest",
			"detail":   "Complete your first issue on the farm.",
			"wearable": true,
			"tiers": []map[string]any{
				{"need": 1, "title": "Sprout Keeper", "coins": 30, "reached": "Harvested your first crop"},
			},
		},
	})
}

func (h *Handler) handleGameTitleSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Achievement string `json:"achievement"`
		Tier        *int   `json:"tier"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if h.st != nil && h.st.Ledger != nil {
		if _, err := h.st.Ledger.Append(r.Context(), game.LedgerEntry{
			Kind:        game.LedgerTitleSet,
			Title:       req.Achievement,
			CreatedAtMs: h.hub.nowMs(),
		}); err != nil {
			writeError(w, err, BizGameRefused)
			return
		}
		h.hub.notifyAllState()
	}
	writeVoid(w)
}
