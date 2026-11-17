package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// InboundMessage represents a normalized message or handshake challenge received from an external platform.
type InboundMessage struct {
	ConnectorID    ConnectorID `json:"connectorId"`
	Kind           string      `json:"kind"`
	ExternalChatID string      `json:"externalChatId"`
	ExternalUserID string      `json:"externalUserId"`
	SenderName     string      `json:"senderName,omitempty"`
	Text           string      `json:"text"`
	Challenge      string      `json:"challenge,omitempty"`
	MessageID      string      `json:"messageId,omitempty"`
	ReplyToID      string      `json:"replyToId,omitempty"`
}

// InboundHandler processes normalized inbound messages received via webhooks or polling.
type InboundHandler func(ctx context.Context, msg InboundMessage) error

// ParseWebhookPayload normalizes an incoming webhook JSON/XML body for the given platform kind.
func ParseWebhookPayload(kind ConnectorID, body []byte) (InboundMessage, error) {
	norm := ConnectorID(strings.ToLower(strings.TrimSpace(string(kind))))
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return InboundMessage{}, fmt.Errorf("%w: empty %s webhook payload", ErrConnectorRefused, norm)
	}

	switch norm {
	case ConnectorTelegram:
		return parseTelegramWebhook(trimmed)
	case ConnectorFeishu:
		return parseFeishuWebhook(trimmed)
	case ConnectorSlack:
		return parseSlackWebhook(trimmed)
	case ConnectorDiscord:
		return parseDiscordWebhook(trimmed)
	case ConnectorQQ:
		return parseQQWebhook(trimmed)
	case ConnectorWeixin:
		return parseWeixinWebhook(trimmed)
	default:
		return InboundMessage{}, fmt.Errorf("%w: unsupported webhook kind %q", ErrConnectorRefused, kind)
	}
}

type telegramUpdate struct {
	UpdateID      int64            `json:"update_id"`
	Message       *telegramMessage `json:"message"`
	EditedMessage *telegramMessage `json:"edited_message"`
	ChannelPost   *telegramMessage `json:"channel_post"`
}

type telegramMessage struct {
	MessageID int64  `json:"message_id"`
	Text      string `json:"text"`
	Caption   string `json:"caption"`
	From      *struct {
		ID        int64  `json:"id"`
		Username  string `json:"username"`
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
	} `json:"from"`
	Chat struct {
		ID    int64  `json:"id"`
		Type  string `json:"type"`
		Title string `json:"title"`
	} `json:"chat"`
	ReplyToMessage *struct {
		MessageID int64 `json:"message_id"`
	} `json:"reply_to_message"`
}

func normalizeTelegramUpdate(u telegramUpdate) (InboundMessage, bool) {
	msg := u.Message
	if msg == nil {
		msg = u.EditedMessage
	}
	if msg == nil {
		msg = u.ChannelPost
	}
	if msg == nil {
		return InboundMessage{}, false
	}
	var userID, senderName string
	if msg.From != nil {
		if msg.From.ID != 0 {
			userID = strconv.FormatInt(msg.From.ID, 10)
		}
		fullName := strings.TrimSpace(msg.From.FirstName + " " + msg.From.LastName)
		senderName = firstNonEmpty(msg.From.Username, fullName, userID)
	}
	var chatID string
	if msg.Chat.ID != 0 {
		chatID = strconv.FormatInt(msg.Chat.ID, 10)
	} else {
		chatID = userID
	}
	var msgID string
	if msg.MessageID != 0 {
		msgID = strconv.FormatInt(msg.MessageID, 10)
	}
	var replyID string
	if msg.ReplyToMessage != nil && msg.ReplyToMessage.MessageID != 0 {
		replyID = strconv.FormatInt(msg.ReplyToMessage.MessageID, 10)
	}
	return InboundMessage{
		ConnectorID:    ConnectorTelegram,
		Kind:           string(ConnectorTelegram),
		ExternalChatID: chatID,
		ExternalUserID: userID,
		SenderName:     senderName,
		Text:           strings.TrimSpace(firstNonEmpty(msg.Text, msg.Caption)),
		MessageID:      msgID,
		ReplyToID:      replyID,
	}, true
}

func parseTelegramWebhook(raw []byte) (InboundMessage, error) {
	var upd telegramUpdate
	if err := json.Unmarshal(raw, &upd); err != nil {
		return InboundMessage{}, fmt.Errorf("%w: invalid telegram webhook: %v", ErrConnectorRefused, err)
	}
	msg, ok := normalizeTelegramUpdate(upd)
	if !ok {
		return InboundMessage{}, fmt.Errorf("%w: telegram webhook has no message", ErrConnectorRefused)
	}
	return msg, nil
}

func parseFeishuWebhook(raw []byte) (InboundMessage, error) {
	var payload struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		Schema    string `json:"schema"`
		Header    *struct {
			EventType string `json:"event_type"`
		} `json:"header"`
		Event *struct {
			Type       string `json:"type"`
			OpenID     string `json:"open_id"`
			OpenChatID string `json:"open_chat_id"`
			Text       string `json:"text"`
			Sender     *struct {
				SenderType string `json:"sender_type"`
				SenderID   *struct {
					OpenID  string `json:"open_id"`
					UserID  string `json:"user_id"`
					UnionID string `json:"union_id"`
				} `json:"sender_id"`
			} `json:"sender"`
			Message *struct {
				MessageID   string `json:"message_id"`
				ChatID      string `json:"chat_id"`
				ChatType    string `json:"chat_type"`
				MessageType string `json:"message_type"`
				Content     string `json:"content"`
				ParentID    string `json:"parent_id"`
			} `json:"message"`
		} `json:"event"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return InboundMessage{}, fmt.Errorf("%w: invalid feishu webhook: %v", ErrConnectorRefused, err)
	}
	if payload.Type == "url_verification" || (payload.Challenge != "" && payload.Event == nil) {
		return InboundMessage{
			ConnectorID: ConnectorFeishu,
			Kind:        string(ConnectorFeishu),
			Challenge:   payload.Challenge,
		}, nil
	}
	if payload.Event == nil {
		return InboundMessage{}, fmt.Errorf("%w: feishu webhook missing event", ErrConnectorRefused)
	}

	if payload.Event.Message != nil {
		var userID string
		if payload.Event.Sender != nil && payload.Event.Sender.SenderID != nil {
			sid := payload.Event.Sender.SenderID
			userID = firstNonEmpty(sid.OpenID, sid.UserID, sid.UnionID)
		}
		text := payload.Event.Message.Content
		var textBody struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(text), &textBody) == nil && textBody.Text != "" {
			text = textBody.Text
		}
		chatID := firstNonEmpty(payload.Event.Message.ChatID, userID)
		return InboundMessage{
			ConnectorID:    ConnectorFeishu,
			Kind:           string(ConnectorFeishu),
			ExternalChatID: chatID,
			ExternalUserID: userID,
			SenderName:     userID,
			Text:           strings.TrimSpace(text),
			MessageID:      payload.Event.Message.MessageID,
			ReplyToID:      payload.Event.Message.ParentID,
		}, nil
	}

	userID := strings.TrimSpace(payload.Event.OpenID)
	chatID := firstNonEmpty(payload.Event.OpenChatID, userID)
	return InboundMessage{
		ConnectorID:    ConnectorFeishu,
		Kind:           string(ConnectorFeishu),
		ExternalChatID: chatID,
		ExternalUserID: userID,
		SenderName:     userID,
		Text:           strings.TrimSpace(payload.Event.Text),
	}, nil
}

func parseSlackWebhook(raw []byte) (InboundMessage, error) {
	var payload struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		Event     *struct {
			Type     string `json:"type"`
			Subtype  string `json:"subtype"`
			Channel  string `json:"channel"`
			User     string `json:"user"`
			Username string `json:"username"`
			Text     string `json:"text"`
			TS       string `json:"ts"`
			ThreadTS string `json:"thread_ts"`
		} `json:"event"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return InboundMessage{}, fmt.Errorf("%w: invalid slack webhook: %v", ErrConnectorRefused, err)
	}
	if payload.Type == "url_verification" || (payload.Challenge != "" && payload.Event == nil) {
		return InboundMessage{
			ConnectorID: ConnectorSlack,
			Kind:        string(ConnectorSlack),
			Challenge:   payload.Challenge,
		}, nil
	}
	if payload.Event == nil {
		return InboundMessage{}, fmt.Errorf("%w: slack webhook missing event", ErrConnectorRefused)
	}
	ev := payload.Event
	return InboundMessage{
		ConnectorID:    ConnectorSlack,
		Kind:           string(ConnectorSlack),
		ExternalChatID: ev.Channel,
		ExternalUserID: ev.User,
		SenderName:     firstNonEmpty(ev.Username, ev.User),
		Text:           strings.TrimSpace(ev.Text),
		MessageID:      ev.TS,
		ReplyToID:      ev.ThreadTS,
	}, nil
}

type discordMsg struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	Content   string `json:"content"`
	Author    *struct {
		ID         string `json:"id"`
		Username   string `json:"username"`
		GlobalName string `json:"global_name"`
	} `json:"author"`
	MessageReference *struct {
		MessageID string `json:"message_id"`
	} `json:"message_reference"`
}

func parseDiscordWebhook(raw []byte) (InboundMessage, error) {
	var envelope struct {
		Type      int             `json:"type"`
		T         string          `json:"t"`
		D         json.RawMessage `json:"d"`
		ChannelID string          `json:"channel_id"`
		ID        string          `json:"id"`
		Content   string          `json:"content"`
		Author    *struct {
			ID         string `json:"id"`
			Username   string `json:"username"`
			GlobalName string `json:"global_name"`
		} `json:"author"`
		MessageReference *struct {
			MessageID string `json:"message_id"`
		} `json:"message_reference"`
		Member *struct {
			User *struct {
				ID         string `json:"id"`
				Username   string `json:"username"`
				GlobalName string `json:"global_name"`
			} `json:"user"`
		} `json:"member"`
		User *struct {
			ID         string `json:"id"`
			Username   string `json:"username"`
			GlobalName string `json:"global_name"`
		} `json:"user"`
		Data *struct {
			Name    string `json:"name"`
			Options []struct {
				Value any `json:"value"`
			} `json:"options"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return InboundMessage{}, fmt.Errorf("%w: invalid discord webhook: %v", ErrConnectorRefused, err)
	}
	if len(envelope.D) > 0 && envelope.D[0] == '{' {
		var msg discordMsg
		if err := json.Unmarshal(envelope.D, &msg); err != nil {
			return InboundMessage{}, fmt.Errorf("%w: invalid discord event payload: %v", ErrConnectorRefused, err)
		}
		return discordInboundFromMsg(msg), nil
	}
	if envelope.Type == 1 && envelope.Content == "" && envelope.Data == nil {
		return InboundMessage{
			ConnectorID: ConnectorDiscord,
			Kind:        string(ConnectorDiscord),
			Challenge:   "pong",
		}, nil
	}
	if envelope.Data != nil && envelope.Content == "" {
		text := "/" + envelope.Data.Name
		if len(envelope.Data.Options) > 0 && envelope.Data.Options[0].Value != nil {
			text = fmt.Sprint(envelope.Data.Options[0].Value)
		}
		u := envelope.User
		if u == nil && envelope.Member != nil {
			u = envelope.Member.User
		}
		var uid, uname string
		if u != nil {
			uid = u.ID
			uname = firstNonEmpty(u.GlobalName, u.Username, u.ID)
		}
		return InboundMessage{
			ConnectorID:    ConnectorDiscord,
			Kind:           string(ConnectorDiscord),
			ExternalChatID: firstNonEmpty(envelope.ChannelID, uid),
			ExternalUserID: uid,
			SenderName:     uname,
			Text:           strings.TrimSpace(text),
			MessageID:      envelope.ID,
		}, nil
	}
	return discordInboundFromMsg(discordMsg{
		ID:               envelope.ID,
		ChannelID:        envelope.ChannelID,
		Content:          envelope.Content,
		Author:           envelope.Author,
		MessageReference: envelope.MessageReference,
	}), nil
}

func discordInboundFromMsg(msg discordMsg) InboundMessage {
	var uid, uname string
	if msg.Author != nil {
		uid = msg.Author.ID
		uname = firstNonEmpty(msg.Author.GlobalName, msg.Author.Username, msg.Author.ID)
	}
	var replyTo string
	if msg.MessageReference != nil {
		replyTo = msg.MessageReference.MessageID
	}
	return InboundMessage{
		ConnectorID:    ConnectorDiscord,
		Kind:           string(ConnectorDiscord),
		ExternalChatID: firstNonEmpty(msg.ChannelID, uid),
		ExternalUserID: uid,
		SenderName:     uname,
		Text:           strings.TrimSpace(msg.Content),
		MessageID:      msg.ID,
		ReplyToID:      replyTo,
	}
}

func parseQQWebhook(raw []byte) (InboundMessage, error) {
	var payload struct {
		Op int             `json:"op"`
		T  string          `json:"t"`
		D  json.RawMessage `json:"d"`
		// Direct fields when unwrapped.
		ID          string `json:"id"`
		Content     string `json:"content"`
		ChannelID   string `json:"channel_id"`
		GroupOpenID string `json:"group_openid"`
		Author      *struct {
			ID           string `json:"id"`
			UserOpenID   string `json:"user_openid"`
			MemberOpenID string `json:"member_openid"`
			Username     string `json:"username"`
		} `json:"author"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return InboundMessage{}, fmt.Errorf("%w: invalid qq webhook: %v", ErrConnectorRefused, err)
	}
	if payload.Op == 13 && len(payload.D) > 0 {
		var verify struct {
			PlainToken string `json:"plain_token"`
		}
		if json.Unmarshal(payload.D, &verify) == nil && verify.PlainToken != "" {
			return InboundMessage{
				ConnectorID: ConnectorQQ,
				Kind:        string(ConnectorQQ),
				Challenge:   verify.PlainToken,
			}, nil
		}
	}
	d := struct {
		ID          string `json:"id"`
		Content     string `json:"content"`
		ChannelID   string `json:"channel_id"`
		GroupOpenID string `json:"group_openid"`
		Author      *struct {
			ID           string `json:"id"`
			UserOpenID   string `json:"user_openid"`
			MemberOpenID string `json:"member_openid"`
			Username     string `json:"username"`
		} `json:"author"`
	}{
		ID:          payload.ID,
		Content:     payload.Content,
		ChannelID:   payload.ChannelID,
		GroupOpenID: payload.GroupOpenID,
		Author:      payload.Author,
	}
	if len(payload.D) > 0 && payload.D[0] == '{' {
		if err := json.Unmarshal(payload.D, &d); err != nil {
			return InboundMessage{}, fmt.Errorf("%w: invalid qq dispatch payload: %v", ErrConnectorRefused, err)
		}
	}
	var uid, uname string
	if d.Author != nil {
		uid = firstNonEmpty(d.Author.UserOpenID, d.Author.MemberOpenID, d.Author.ID)
		uname = firstNonEmpty(d.Author.Username, uid)
	}
	chatID := firstNonEmpty(d.ChannelID, d.GroupOpenID, uid)
	return InboundMessage{
		ConnectorID:    ConnectorQQ,
		Kind:           string(ConnectorQQ),
		ExternalChatID: chatID,
		ExternalUserID: uid,
		SenderName:     uname,
		Text:           strings.TrimSpace(d.Content),
		MessageID:      d.ID,
	}, nil
}

func parseWeixinWebhook(raw []byte) (InboundMessage, error) {
	if bytes.HasPrefix(raw, []byte("<")) {
		var xmlMsg struct {
			ToUserName   string `xml:"ToUserName"`
			FromUserName string `xml:"FromUserName"`
			MsgType      string `xml:"MsgType"`
			Content      string `xml:"Content"`
			Recognition  string `xml:"Recognition"`
			MsgId        string `xml:"MsgId"`
		}
		if err := xml.Unmarshal(raw, &xmlMsg); err != nil {
			return InboundMessage{}, fmt.Errorf("%w: invalid weixin xml webhook: %v", ErrConnectorRefused, err)
		}
		text := strings.TrimSpace(firstNonEmpty(xmlMsg.Content, xmlMsg.Recognition))
		uid := strings.TrimSpace(xmlMsg.FromUserName)
		return InboundMessage{
			ConnectorID:    ConnectorWeixin,
			Kind:           string(ConnectorWeixin),
			ExternalChatID: firstNonEmpty(uid, strings.TrimSpace(xmlMsg.ToUserName)),
			ExternalUserID: uid,
			SenderName:     uid,
			Text:           text,
			MessageID:      strings.TrimSpace(xmlMsg.MsgId),
		}, nil
	}

	var payload struct {
		Challenge    string `json:"challenge"`
		Echostr      string `json:"echostr"`
		FromUserID   string `json:"from_user_id"`
		ToUserID     string `json:"to_user_id"`
		GroupID      string `json:"group_id"`
		MessageID    string `json:"message_id"`
		ContextToken string `json:"context_token"`
		Text         string `json:"text"`
		Content      string `json:"content"`
		FromUserName string `json:"FromUserName"`
		MsgID        string `json:"MsgId"`
		ItemList     []struct {
			Type     int `json:"type"`
			TextItem *struct {
				Text string `json:"text"`
			} `json:"text_item"`
			VoiceItem *struct {
				Text string `json:"text"`
			} `json:"voice_item"`
		} `json:"item_list"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return InboundMessage{}, fmt.Errorf("%w: invalid weixin json webhook: %v", ErrConnectorRefused, err)
	}
	if ch := firstNonEmpty(payload.Challenge, payload.Echostr); ch != "" && payload.FromUserID == "" && payload.FromUserName == "" {
		return InboundMessage{
			ConnectorID: ConnectorWeixin,
			Kind:        string(ConnectorWeixin),
			Challenge:   ch,
		}, nil
	}
	var itemParts []string
	for _, it := range payload.ItemList {
		if it.TextItem != nil && strings.TrimSpace(it.TextItem.Text) != "" {
			itemParts = append(itemParts, strings.TrimSpace(it.TextItem.Text))
		} else if it.VoiceItem != nil && strings.TrimSpace(it.VoiceItem.Text) != "" {
			itemParts = append(itemParts, strings.TrimSpace(it.VoiceItem.Text))
		}
	}
	text := strings.TrimSpace(firstNonEmpty(payload.Text, payload.Content, strings.Join(itemParts, "\n")))
	uid := firstNonEmpty(payload.FromUserID, payload.FromUserName)
	chatID := firstNonEmpty(payload.GroupID, uid, payload.ToUserID)
	return InboundMessage{
		ConnectorID:    ConnectorWeixin,
		Kind:           string(ConnectorWeixin),
		ExternalChatID: chatID,
		ExternalUserID: uid,
		SenderName:     uid,
		Text:           text,
		MessageID:      firstNonEmpty(payload.MessageID, payload.MsgID),
		ReplyToID:      payload.ContextToken,
	}, nil
}

// SetInboundHandler registers a callback invoked when webhook or polling receives an inbound message.
func (s *Service) SetInboundHandler(fn InboundHandler) {
	s.mu.Lock()
	s.onInbound = fn
	s.mu.Unlock()
}

// HandleWebhook parses an incoming webhook body for connector id, records LastInbound, and invokes the
// registered inbound callback (unless the payload is purely a challenge handshake).
func (s *Service) HandleWebhook(ctx context.Context, id ConnectorID, body []byte) (InboundMessage, error) {
	if err := ctx.Err(); err != nil {
		return InboundMessage{}, err
	}
	msg, err := ParseWebhookPayload(id, body)
	if err != nil {
		return InboundMessage{}, err
	}
	msg.ConnectorID = id
	if msg.Kind == "" {
		msg.Kind = string(id)
	}
	if msg.Challenge != "" && msg.Text == "" && msg.ExternalUserID == "" {
		return msg, nil
	}
	return msg, s.dispatchInbound(ctx, id, []InboundMessage{msg})
}

func (s *Service) dispatchInbound(ctx context.Context, id ConnectorID, msgs []InboundMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	now := s.clock.NowMs()
	s.mu.Lock()
	if acc, ok := s.accounts[id]; ok {
		acc.LastInbound = &now
		s.accounts[id] = acc
		_ = s.persistLocked()
	}
	cb := s.onInbound
	s.mu.Unlock()

	if cb == nil {
		return nil
	}
	for _, m := range msgs {
		if err := cb(ctx, m); err != nil {
			return err
		}
	}
	return nil
}

// PollTelegramUpdates fetches updates via Telegram getUpdates, normalizes them into InboundMessage values,
// invokes any registered inbound callback, and returns the messages plus next offset.
func (s *Service) PollTelegramUpdates(ctx context.Context, offset int64, timeoutSec int) ([]InboundMessage, int64, error) {
	if err := ctx.Err(); err != nil {
		return nil, offset, err
	}
	s.mu.RLock()
	acc, hasAcc := s.accounts[ConnectorTelegram]
	defaultBase := s.apiBaseURLs[ConnectorTelegram]
	if defaultBase == "" {
		defaultBase = s.apiBaseURL
	}
	httpClient := s.httpClient
	s.mu.RUnlock()

	if !hasAcc || len(acc.Secrets) == 0 {
		return nil, offset, fmt.Errorf("%w: telegram connector has no credentials", ErrConnectorRefused)
	}
	tok := firstNonEmpty(acc.Secrets["botToken"], acc.Secrets["secret"])
	if tok == "" {
		return nil, offset, fmt.Errorf("%w: telegram botToken is missing", ErrConnectorRefused)
	}
	base := firstNonEmpty(cleanBaseURL(acc.Secrets["apiBaseUrl"]), cleanBaseURL(defaultBase), defaultTelegramBaseURL)
	if timeoutSec < 0 {
		timeoutSec = 0
	}
	endpoint := fmt.Sprintf("%s/bot%s/getUpdates?offset=%d&timeout=%d", base, url.PathEscape(tok), offset, timeoutSec)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, offset, err
	}
	req.Header.Set("Accept", "application/json")
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, offset, fmt.Errorf("telegram getUpdates: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxConnectorRespBytes))
	if err != nil {
		return nil, offset, err
	}
	var decoded struct {
		OK          bool             `json:"ok"`
		Description string           `json:"description"`
		Result      []telegramUpdate `json:"result"`
	}
	if err := decodeCheckedJSON(resp.StatusCode, raw, &decoded); err != nil || !decoded.OK {
		msg := firstNonEmpty(decoded.Description, errString(err), fmt.Sprintf("HTTP %d", resp.StatusCode))
		return nil, offset, fmt.Errorf("%w: telegram getUpdates failed: %s", ErrConnectorRefused, msg)
	}

	nextOffset := offset
	msgs := make([]InboundMessage, 0, len(decoded.Result))
	for _, upd := range decoded.Result {
		if upd.UpdateID >= nextOffset {
			nextOffset = upd.UpdateID + 1
		}
		if m, ok := normalizeTelegramUpdate(upd); ok {
			msgs = append(msgs, m)
		}
	}
	if err := s.dispatchInbound(ctx, ConnectorTelegram, msgs); err != nil {
		return msgs, nextOffset, err
	}
	return msgs, nextOffset, nil
}

// VerifyOutboundReady reports an error when connector id cannot send outbound messages.
func validateSendState(acc storedAccount, hasAcc bool, id ConnectorID, targetChatID, text string) (string, error) {
	if !hasAcc {
		return "", fmt.Errorf("%w: connector %q is not configured", ErrConnectorRefused, id)
	}
	if acc.State != StateConnected && acc.State != StatePairing {
		return "", fmt.Errorf("%w: connector %q is not connected", ErrConnectorRefused, id)
	}
	if len(acc.Secrets) == 0 {
		return "", fmt.Errorf("%w: connector %q has no credentials", ErrConnectorRefused, id)
	}
	target := strings.TrimSpace(targetChatID)
	if target == "" {
		target = strings.TrimSpace(acc.User)
	}
	if target == "" {
		return "", fmt.Errorf("%w: target chat id is required", ErrConnectorRefused)
	}
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("%w: %w", ErrConnectorRefused, errors.New("message text is empty"))
	}
	return target, nil
}
