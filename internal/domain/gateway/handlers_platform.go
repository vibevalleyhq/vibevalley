package gateway

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/domain/attachment"
	"github.com/vibevalleyhq/vibevalley/internal/domain/connector"
	"github.com/vibevalleyhq/vibevalley/internal/domain/lan"
	"github.com/vibevalleyhq/vibevalley/internal/domain/setting"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
	"github.com/vibevalleyhq/vibevalley/internal/domain/voice"
)

func (h *Handler) handleHealthGet(w http.ResponseWriter, _ *http.Request) {
	ver := "0.1.0-dev"
	if h.st != nil && h.st.Version() != "" {
		ver = h.st.Version()
	}
	writeSuccess(w, map[string]any{
		"ok":      true,
		"version": ver,
	})
}

func normalizeSettingsStatus(st setting.SettingsStatus) setting.SettingsStatus {
	if st.Locale == "en" {
		const expectedEN = "Hey there! What shall we grow today?"
		const oldEN = "Hi there! What are we working on today?"
		if st.VoiceDefaults.Greeting == "" || st.VoiceDefaults.Greeting == oldEN {
			st.VoiceDefaults.Greeting = expectedEN
		}
		if st.Voice.Greeting == oldEN {
			st.Voice.Greeting = expectedEN
		}
	}
	return st
}

func setDeviceKeyCookie(w http.ResponseWriter, r *http.Request, key string, maxAge int) {
	age := maxAge
	val := url.PathEscape(key)
	if maxAge <= 0 {
		age = -1
		val = ""
	}
	http.SetCookie(w, &http.Cookie{
		Name:     user.DeviceKeyCookie,
		Value:    val,
		Path:     "/",
		MaxAge:   age,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
	})
}

func (h *Handler) handleSettingGet(w http.ResponseWriter, _ *http.Request) {
	if h.st == nil || h.st.Setting == nil {
		writeError(w, newBizError(BizServiceUnavailable, "setting service unavailable"), BizServiceUnavailable)
		return
	}
	writeSuccess(w, normalizeSettingsStatus(h.st.Setting.Get()))
}

func (h *Handler) handleSettingValidate(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Setting == nil {
		writeError(w, newBizError(BizServiceUnavailable, "setting service unavailable"), BizServiceUnavailable)
		return
	}
	var req setting.SettingsUpdate
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, h.st.Setting.Validate(r.Context(), req))
}

func (h *Handler) handleSettingUpdate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Setting == nil {
		writeError(w, newBizError(BizServiceUnavailable, "setting service unavailable"), BizServiceUnavailable)
		return
	}
	var req setting.SettingsUpdate
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.Setting.Update(r.Context(), req)
	if err != nil {
		writeError(w, err, BizSettingRefused)
		return
	}
	h.hub.mu.Lock()
	h.hub.state.OrchNoKeySent = make(map[string]bool)
	h.hub.mu.Unlock()
	h.hub.notifyAllState()
	writeSuccess(w, normalizeSettingsStatus(res))
}

func (h *Handler) handleProviderGet(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Setting == nil {
		writeError(w, newBizError(BizServiceUnavailable, "setting service unavailable"), BizServiceUnavailable)
		return
	}
	writeSuccess(w, h.st.Setting.ProviderStatus())
}

func (h *Handler) handleProviderUpdate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Setting == nil {
		writeError(w, newBizError(BizServiceUnavailable, "setting service unavailable"), BizServiceUnavailable)
		return
	}
	var req setting.ProviderUpdate
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.Setting.UpdateProviders(r.Context(), req)
	if err != nil {
		writeError(w, err, BizProviderRefused)
		return
	}
	h.hub.notifyAllState()
	writeSuccess(w, res)
}

func (h *Handler) handleProviderModelList(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Setting == nil {
		writeError(w, newBizError(BizServiceUnavailable, "setting service unavailable"), BizServiceUnavailable)
		return
	}
	var req setting.ProviderModelRequest
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.Setting.ListModels(r.Context(), &req)
	if err != nil {
		writeError(w, err, BizProviderRefused)
		return
	}
	if res.Models == nil {
		res.Models = []setting.ProviderModel{}
	}
	writeSuccess(w, res)
}

func (h *Handler) handleProviderVoiceList(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Setting == nil {
		writeError(w, newBizError(BizServiceUnavailable, "setting service unavailable"), BizServiceUnavailable)
		return
	}
	var req setting.ProviderVoiceRequest
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if off, handled, oErr := h.offlineVoiceList(r.Context(), req); handled {
		if oErr != nil {
			writeError(w, oErr, BizProviderRefused)
			return
		}
		if off.Voices == nil {
			off.Voices = []setting.ProviderVoice{}
		}
		writeSuccess(w, off)
		return
	}
	res, err := h.st.Setting.ListProviderVoices(r.Context(), req)
	if err != nil {
		writeError(w, err, BizProviderRefused)
		return
	}
	if res.Voices == nil {
		res.Voices = []setting.ProviderVoice{}
	}
	writeSuccess(w, res)
}

func (h *Handler) handleUserGet(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	writeSuccess(w, h.st.User.Status(caller))
}

func (h *Handler) handleUserUpdate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.User.UpdateProfile(req.Name)
	if err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleUserPasswordSet(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireLocalUser(caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.User.SetPassword(caller, req.Password)
	if err != nil {
		writeError(w, err, BizAuthRefused)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleUserLogin(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		Password string `json:"password"`
		Device   string `json:"device"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	login, err := h.st.User.Login(req.Password, req.Device)
	if err != nil {
		writeError(w, err, BizAuthRefused)
		return
	}
	if r.Header.Get(lan.HeaderOutside) == "1" {
		setDeviceKeyCookie(w, r, login.Key, 10*365*24*3600)
	}
	writeSuccess(w, login)
}

func (h *Handler) handleUserLogout(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	if err := h.st.User.Logout(caller); err != nil {
		writeError(w, err, BizAuthRefused)
		return
	}
	if r.Header.Get(lan.HeaderOutside) == "1" {
		setDeviceKeyCookie(w, r, "", 0)
	}
	writeVoid(w)
}

func (h *Handler) handleUserDeviceList(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	devs := h.st.User.ListDevices()
	if devs == nil {
		devs = []user.UserDevice{}
	}
	writeSuccess(w, devs)
}

func (h *Handler) handleUserDeviceDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	devs, err := h.st.User.RevokeDevice(req.ID)
	if err != nil {
		writeError(w, err, BizUserNotFound)
		return
	}
	if devs == nil {
		devs = []user.UserDevice{}
	}
	writeSuccess(w, devs)
}

func (h *Handler) handleUserDevicePreviewDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	prev, err := h.st.User.PreviewRevokeDevice(req.ID)
	if err != nil {
		writeError(w, err, BizUserNotFound)
		return
	}
	if prev.Does == nil {
		prev.Does = []string{}
	}
	writeSuccess(w, prev)
}

func (h *Handler) handleUserApprovalCreate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.User.CreateApproval(caller, req.Name)
	if err != nil {
		writeError(w, err, BizAuthRefused)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleUserApprovalCollect(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		Claim string `json:"claim"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.User.PollApproval(req.Claim)
	if err != nil {
		writeError(w, err, BizUserNotFound)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleUserApprovalList(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	list := h.st.User.ListApprovals()
	if list == nil {
		list = []user.Approval{}
	}
	writeSuccess(w, list)
}

func (h *Handler) handleUserApprovalAnswer(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.User == nil {
		writeError(w, newBizError(BizServiceUnavailable, "user service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		ID    string `json:"id"`
		Allow bool   `json:"allow"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	list, err := h.st.User.AnswerApproval(req.ID, req.Allow)
	if err != nil {
		writeError(w, err, BizUserNotFound)
		return
	}
	if list == nil {
		list = []user.Approval{}
	}
	writeSuccess(w, list)
}

func (h *Handler) handleLanGet(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.LAN == nil {
		writeError(w, newBizError(BizLanUnavailable, "lan service unavailable"), BizLanUnavailable)
		return
	}
	writeSuccess(w, h.st.LAN.Get())
}

func (h *Handler) handleLanUpdate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.LAN == nil {
		writeError(w, newBizError(BizLanUnavailable, "lan service unavailable"), BizLanUnavailable)
		return
	}
	var req lan.UpdateRequest
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	// Run with background context when opening listener so HTTP cancellation does not stop listener.
	res, err := h.st.LAN.Update(context.Background(), req)
	if err != nil {
		writeError(w, err, BizLanUnavailable)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleLanPairingStart(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.LAN == nil {
		writeError(w, newBizError(BizLanUnavailable, "lan service unavailable"), BizLanUnavailable)
		return
	}
	res, err := h.st.LAN.StartPairing()
	if err != nil {
		writeError(w, err, BizLanUnavailable)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleLanPairingStop(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.LAN == nil {
		writeError(w, newBizError(BizLanUnavailable, "lan service unavailable"), BizLanUnavailable)
		return
	}
	writeSuccess(w, h.st.LAN.StopPairing())
}

func (h *Handler) handleLanPairingPreviewStop(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.LAN == nil {
		writeError(w, newBizError(BizLanUnavailable, "lan service unavailable"), BizLanUnavailable)
		return
	}
	prev := h.st.LAN.PreviewStop()
	if prev.Does == nil {
		prev.Does = []string{}
	}
	writeSuccess(w, prev)
}

func (h *Handler) handleLanPairingAnswer(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.LAN == nil {
		writeError(w, newBizError(BizLanUnavailable, "lan service unavailable"), BizLanUnavailable)
		return
	}
	var req struct {
		Allow bool `json:"allow"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.LAN.AnswerPairing(req.Allow)
	if err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleLanPair(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.LAN == nil {
		writeError(w, newBizError(BizLanUnavailable, "lan service unavailable"), BizLanUnavailable)
		return
	}
	var req struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.LAN.PairWithCode(r.Context(), req.Code, req.Name)
	if err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	writeSuccess(w, res)
}

func (h *Handler) handleAttachmentCreate(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Attachments == nil {
		writeError(w, newBizError(BizServiceUnavailable, "attachment store unavailable"), BizServiceUnavailable)
		return
	}
	var req attachment.AttachmentUpload
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	att, err := h.st.Attachments.CreateFromBase64(r.Context(), req)
	if err != nil {
		writeError(w, err, BizAttachmentRefused)
		return
	}
	writeSuccess(w, att)
}

func (h *Handler) handleAttachmentGet(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Attachments == nil {
		writeError(w, newBizError(BizServiceUnavailable, "attachment store unavailable"), BizServiceUnavailable)
		return
	}
	if !strings.HasPrefix(r.URL.Path, attachment.PathPrefix) {
		writeError(w, newBizError(BizRouteNotFound, "attachment not found"), BizRouteNotFound)
		return
	}
	h.st.Attachments.ServeHTTP(w, r)
}

func (h *Handler) handleConnectorList(w http.ResponseWriter, _ *http.Request) {
	if h.st == nil || h.st.Connectors == nil {
		writeSuccess(w, []connector.ConnectorStatus{})
		return
	}
	writeSuccess(w, filterProtocolConnectors(h.st.Connectors.List()))
}

func (h *Handler) handleConnectorLogin(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Connectors == nil {
		writeError(w, newBizError(BizServiceUnavailable, "connector service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		ID       connector.ConnectorID `json:"id"`
		Force    bool                  `json:"force"`
		AppID    string                `json:"appId"`
		Secret   string                `json:"secret"`
		BotToken string                `json:"botToken"`
		Domain   string                `json:"domain"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	st, err := h.st.Connectors.Login(r.Context(), req.ID, connector.ConnectorLogin{
		Force:    req.Force,
		AppID:    req.AppID,
		Secret:   req.Secret,
		BotToken: req.BotToken,
		Domain:   req.Domain,
	})
	if err != nil {
		writeError(w, err, BizConnectorRefused)
		return
	}
	h.hub.notifyAllState()
	writeSuccess(w, st)
}

func (h *Handler) handleConnectorVerify(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Connectors == nil {
		writeError(w, newBizError(BizServiceUnavailable, "connector service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		ID   connector.ConnectorID `json:"id"`
		Code string                `json:"code"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	st, err := h.st.Connectors.Verify(r.Context(), req.ID, req.Code)
	if err != nil {
		writeError(w, err, BizConnectorRefused)
		return
	}
	h.hub.notifyAllState()
	writeSuccess(w, st)
}

func (h *Handler) handleConnectorLogout(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Connectors == nil {
		writeError(w, newBizError(BizServiceUnavailable, "connector service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		ID connector.ConnectorID `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	st, err := h.st.Connectors.Logout(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizConnectorRefused)
		return
	}
	h.hub.notifyAllState()
	writeSuccess(w, st)
}

func (h *Handler) handleConnectorChannelSet(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Connectors == nil {
		writeError(w, newBizError(BizServiceUnavailable, "connector service unavailable"), BizServiceUnavailable)
		return
	}
	var req struct {
		ID      connector.ConnectorID `json:"id"`
		Channel string                `json:"channel"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	st, err := h.st.Connectors.SetChannel(r.Context(), req.ID, req.Channel)
	if err != nil {
		writeError(w, err, BizConnectorRefused)
		return
	}
	h.hub.notifyAllState()
	writeSuccess(w, st)
}

func (h *Handler) handleVoiceHear(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	var req struct {
		Text    string `json:"text"`
		Agent   string `json:"agent"`
		SendKey string `json:"sendKey"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := h.st.Voice.Hear(r.Context(), req.Text, req.Agent, req.SendKey); err != nil {
		writeError(w, err, BizVoiceCallFailed)
		return
	}
	writeVoid(w)
}

func (h *Handler) handleVoiceMossVerify(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireOwnerOrLogin(h.st, caller); err != nil {
		writeError(w, err, BizForbidden)
		return
	}
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	writeSuccess(w, h.st.Voice.MossVerify(r.Context()))
}

func (h *Handler) handleVoiceGrantCreate(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	grant, err := h.st.Voice.GrantCreate(r.Context())
	if err != nil {
		writeError(w, err, BizVoiceUnavailable)
		return
	}
	writeSuccess(w, grant)
}

func (h *Handler) handleVoiceGrantRenew(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	var req voice.VoiceGrantRenew
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	grant, err := h.st.Voice.GrantRenew(r.Context(), req)
	if err != nil {
		writeError(w, err, BizVoiceUnavailable)
		return
	}
	writeSuccess(w, grant)
}

func (h *Handler) handleVoiceCallStart(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	var req voice.VoiceCallStart
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	call, err := h.st.Voice.CallStart(r.Context(), req)
	if err != nil {
		writeError(w, err, BizVoiceCallFailed)
		return
	}
	h.hub.notifyAllState()
	writeSuccess(w, call)
}

func (h *Handler) handleVoiceCallStop(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	var req voice.VoiceCall
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := h.st.Voice.CallStop(r.Context(), req); err != nil {
		writeError(w, err, BizVoiceCallFailed)
		return
	}
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleVoiceCallHear(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	var req voice.VoiceHeard
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := h.st.Voice.CallHear(r.Context(), req); err != nil {
		writeError(w, err, BizVoiceCallFailed)
		return
	}
	writeVoid(w)
}

func (h *Handler) handleVoiceCallSay(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	var req voice.VoiceSaid
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := h.st.Voice.CallSay(r.Context(), req); err != nil {
		writeError(w, err, BizVoiceCallFailed)
		return
	}
	writeVoid(w)
}

func (h *Handler) handleVoiceDictate(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Voice == nil {
		writeError(w, newBizError(BizVoiceUnavailable, "voice service unavailable"), BizVoiceUnavailable)
		return
	}
	var req voice.DictateRequest
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	res, err := h.st.Voice.Dictate(r.Context(), req)
	if err != nil {
		writeError(w, err, BizVoiceRefused)
		return
	}
	writeSuccess(w, res)
}
