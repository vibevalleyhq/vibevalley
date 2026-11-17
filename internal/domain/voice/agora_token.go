package voice

import (
	"bytes"
	"compress/zlib"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"slices"
	"time"
)

const (
	// AccessToken2Version is the Token007 prefix emitted by Agora AccessToken2.
	AccessToken2Version = "007"

	ServiceTypeRTC uint16 = 1
	ServiceTypeRTM uint16 = 2

	PrivilegeJoinChannel        uint16 = 1
	PrivilegePublishAudioStream uint16 = 2
	PrivilegePublishVideoStream uint16 = 3
	PrivilegePublishDataStream  uint16 = 4
	PrivilegeLoginRTM           uint16 = 1

	// DefaultTokenSeconds is the default Agora grant lifetime (1 hour).
	DefaultTokenSeconds uint32 = 3600
)

// RtcRole controls channel publish privileges when building RTC tokens.
type RtcRole uint16

const (
	RolePublisher  RtcRole = 1
	RoleSubscriber RtcRole = 2
)

var (
	ErrInvalidAgoraCredentials = errors.New("voice: invalid agora appId or appCertificate")
	ErrInvalidToken            = errors.New("voice: invalid access token")

	agoraHex32Re = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
)

// AccessTokenService represents one service block inside an Agora AccessToken2 payload.
type AccessTokenService interface {
	ServiceType() uint16
	Privileges() map[uint16]uint32
	Pack() []byte
}

// ServiceRTC packs RTC channel and user account privileges (service type 1).
type ServiceRTC struct {
	ChannelName string
	UID         string
	privileges  map[uint16]uint32
}

// NewServiceRTC constructs an RTC service block for channelName and uid.
func NewServiceRTC(channelName, uid string) *ServiceRTC {
	if uid == "0" {
		uid = ""
	}
	return &ServiceRTC{
		ChannelName: channelName,
		UID:         uid,
		privileges:  make(map[uint16]uint32),
	}
}

func (s *ServiceRTC) ServiceType() uint16 { return ServiceTypeRTC }

func (s *ServiceRTC) AddPrivilege(privilege uint16, expireSeconds uint32) {
	if s.privileges == nil {
		s.privileges = make(map[uint16]uint32)
	}
	s.privileges[privilege] = expireSeconds
}

func (s *ServiceRTC) Privileges() map[uint16]uint32 {
	out := make(map[uint16]uint32, len(s.privileges))
	for k, v := range s.privileges {
		out[k] = v
	}
	return out
}

func (s *ServiceRTC) Pack() []byte {
	var b byteWriter
	b.putUint16(ServiceTypeRTC)
	b.putUint32Map(s.privileges)
	b.putString(s.ChannelName)
	b.putString(s.UID)
	return b.bytes()
}

// ServiceRTM packs RTM login privileges (service type 2).
type ServiceRTM struct {
	UserID     string
	privileges map[uint16]uint32
}

// NewServiceRTM constructs an RTM service block for userID.
func NewServiceRTM(userID string) *ServiceRTM {
	return &ServiceRTM{
		UserID:     userID,
		privileges: make(map[uint16]uint32),
	}
}

func (s *ServiceRTM) ServiceType() uint16 { return ServiceTypeRTM }

func (s *ServiceRTM) AddPrivilege(privilege uint16, expireSeconds uint32) {
	if s.privileges == nil {
		s.privileges = make(map[uint16]uint32)
	}
	s.privileges[privilege] = expireSeconds
}

func (s *ServiceRTM) Privileges() map[uint16]uint32 {
	out := make(map[uint16]uint32, len(s.privileges))
	for k, v := range s.privileges {
		out[k] = v
	}
	return out
}

func (s *ServiceRTM) Pack() []byte {
	var b byteWriter
	b.putUint16(ServiceTypeRTM)
	b.putUint32Map(s.privileges)
	b.putString(s.UserID)
	return b.bytes()
}

// AccessToken2 builds Agora Token007 tokens in pure Go (zlib + HMAC-SHA256 binary packer).
type AccessToken2 struct {
	AppID          string
	AppCertificate string
	IssueTs        uint32
	Expire         uint32
	Salt           uint32
	Services       []AccessTokenService
}

// NewAccessToken2 initializes an AccessToken2 with random salt in [1, 99999999].
func NewAccessToken2(appID, appCertificate string, issueTs, expire uint32) (*AccessToken2, error) {
	if !agoraHex32Re.MatchString(appID) || !agoraHex32Re.MatchString(appCertificate) {
		return nil, ErrInvalidAgoraCredentials
	}
	if issueTs == 0 {
		issueTs = uint32(time.Now().Unix())
	}
	salt, err := randomSalt()
	if err != nil {
		return nil, err
	}
	return &AccessToken2{
		AppID:          appID,
		AppCertificate: appCertificate,
		IssueTs:        issueTs,
		Expire:         expire,
		Salt:           salt,
	}, nil
}

// AddService attaches an AccessTokenService block to the token.
func (t *AccessToken2) AddService(svc AccessTokenService) {
	if svc != nil {
		t.Services = append(t.Services, svc)
	}
}

// Build packs, signs via chained HMAC-SHA256, zlib-compresses, base64-encodes, and prefixes "007".
func (t *AccessToken2) Build() (string, error) {
	if !agoraHex32Re.MatchString(t.AppID) || !agoraHex32Re.MatchString(t.AppCertificate) {
		return "", ErrInvalidAgoraCredentials
	}
	if len(t.Services) == 0 {
		return "", fmt.Errorf("%w: at least one service is required", ErrInvalidToken)
	}

	signing := deriveAccessToken2SigningKey(t.AppCertificate, t.IssueTs, t.Salt)

	type indexedSvc struct {
		svc AccessTokenService
		idx int
	}
	ordered := make([]indexedSvc, len(t.Services))
	for i, s := range t.Services {
		ordered[i] = indexedSvc{svc: s, idx: i}
	}
	slices.SortStableFunc(ordered, func(a, b indexedSvc) int {
		if a.svc.ServiceType() != b.svc.ServiceType() {
			if a.svc.ServiceType() < b.svc.ServiceType() {
				return -1
			}
			return 1
		}
		if a.idx < b.idx {
			return -1
		}
		if a.idx > b.idx {
			return 1
		}
		return 0
	})

	var info byteWriter
	info.putString(t.AppID)
	info.putUint32(t.IssueTs)
	info.putUint32(t.Expire)
	info.putUint32(t.Salt)
	info.putUint16(uint16(len(ordered)))
	for _, entry := range ordered {
		info.writeRaw(entry.svc.Pack())
	}
	signingInfo := info.bytes()

	signature := hmacSHA256(signing, signingInfo)

	var content byteWriter
	content.putBytes(signature)
	content.writeRaw(signingInfo)

	var compressed bytes.Buffer
	zw := zlib.NewWriter(&compressed)
	if _, err := zw.Write(content.bytes()); err != nil {
		return "", err
	}
	if err := zw.Close(); err != nil {
		return "", err
	}

	return AccessToken2Version + base64.StdEncoding.EncodeToString(compressed.Bytes()), nil
}

// BuildTokenWithRTM builds a Token007 granting RTC channel access and RTM login,
// matching Agora RtcTokenBuilder2.buildTokenWithRtm.
func BuildTokenWithRTM(appID, appCertificate, channelName, account string, role RtcRole, tokenExpire, privilegeExpire uint32) (string, error) {
	return BuildTokenWithRTMAt(appID, appCertificate, channelName, account, role, 0, tokenExpire, privilegeExpire)
}

// BuildTokenWithRTMAt builds a Token007 with explicit issue timestamp (0 uses current wall time).
func BuildTokenWithRTMAt(appID, appCertificate, channelName, account string, role RtcRole, issueTs, tokenExpire, privilegeExpire uint32) (string, error) {
	tok, err := NewAccessToken2(appID, appCertificate, issueTs, tokenExpire)
	if err != nil {
		return "", err
	}
	rtc := NewServiceRTC(channelName, account)
	rtc.AddPrivilege(PrivilegeJoinChannel, privilegeExpire)
	if role == RolePublisher {
		rtc.AddPrivilege(PrivilegePublishAudioStream, privilegeExpire)
		rtc.AddPrivilege(PrivilegePublishVideoStream, privilegeExpire)
		rtc.AddPrivilege(PrivilegePublishDataStream, privilegeExpire)
	}
	tok.AddService(rtc)

	rtm := NewServiceRTM(account)
	rtm.AddPrivilege(PrivilegeLoginRTM, tokenExpire)
	tok.AddService(rtm)

	return tok.Build()
}

// ParsedAccessToken holds a decoded Token007 payload and signature bytes for inspection and verification.
type ParsedAccessToken struct {
	AppID       string
	IssueTs     uint32
	Expire      uint32
	Salt        uint32
	Services    []AccessTokenService
	signature   []byte
	signingInfo []byte
}

// ParseAccessToken2 decodes an Agora "007..." token into its header and service claims.
func ParseAccessToken2(raw string) (*ParsedAccessToken, error) {
	if len(raw) < len(AccessToken2Version) || raw[:len(AccessToken2Version)] != AccessToken2Version {
		return nil, fmt.Errorf("%w: missing 007 version prefix", ErrInvalidToken)
	}
	compressed, err := base64.StdEncoding.DecodeString(raw[len(AccessToken2Version):])
	if err != nil {
		return nil, fmt.Errorf("%w: invalid base64: %v", ErrInvalidToken, err)
	}
	zr, err := zlib.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, fmt.Errorf("%w: zlib header: %v", ErrInvalidToken, err)
	}
	defer zr.Close()

	plain, err := io.ReadAll(io.LimitReader(zr, 256*1024))
	if err != nil {
		return nil, fmt.Errorf("%w: zlib inflate: %v", ErrInvalidToken, err)
	}

	r := byteReader{buf: plain}
	sig, err := r.getBytes()
	if err != nil {
		return nil, fmt.Errorf("%w: signature: %v", ErrInvalidToken, err)
	}
	signingInfo := slices.Clone(r.rest())

	appID, err := r.getString()
	if err != nil {
		return nil, fmt.Errorf("%w: appId: %v", ErrInvalidToken, err)
	}
	issueTs, err := r.getUint32()
	if err != nil {
		return nil, fmt.Errorf("%w: issueTs: %v", ErrInvalidToken, err)
	}
	expire, err := r.getUint32()
	if err != nil {
		return nil, fmt.Errorf("%w: expire: %v", ErrInvalidToken, err)
	}
	salt, err := r.getUint32()
	if err != nil {
		return nil, fmt.Errorf("%w: salt: %v", ErrInvalidToken, err)
	}
	svcCount, err := r.getUint16()
	if err != nil {
		return nil, fmt.Errorf("%w: service count: %v", ErrInvalidToken, err)
	}

	services := make([]AccessTokenService, 0, svcCount)
	for range svcCount {
		svcType, err := r.getUint16()
		if err != nil {
			return nil, fmt.Errorf("%w: service type: %v", ErrInvalidToken, err)
		}
		privs, err := r.getUint32Map()
		if err != nil {
			return nil, fmt.Errorf("%w: service privileges: %v", ErrInvalidToken, err)
		}
		switch svcType {
		case ServiceTypeRTC:
			ch, err := r.getString()
			if err != nil {
				return nil, fmt.Errorf("%w: rtc channel: %v", ErrInvalidToken, err)
			}
			uid, err := r.getString()
			if err != nil {
				return nil, fmt.Errorf("%w: rtc uid: %v", ErrInvalidToken, err)
			}
			services = append(services, &ServiceRTC{ChannelName: ch, UID: uid, privileges: privs})
		case ServiceTypeRTM:
			uid, err := r.getString()
			if err != nil {
				return nil, fmt.Errorf("%w: rtm userId: %v", ErrInvalidToken, err)
			}
			services = append(services, &ServiceRTM{UserID: uid, privileges: privs})
		default:
			return &ParsedAccessToken{
				AppID:       appID,
				IssueTs:     issueTs,
				Expire:      expire,
				Salt:        salt,
				Services:    services,
				signature:   sig,
				signingInfo: signingInfo,
			}, nil
		}
	}

	return &ParsedAccessToken{
		AppID:       appID,
		IssueTs:     issueTs,
		Expire:      expire,
		Salt:        salt,
		Services:    services,
		signature:   sig,
		signingInfo: signingInfo,
	}, nil
}

// VerifySignature checks the HMAC-SHA256 token signature against appCertificate in constant time.
func (p *ParsedAccessToken) VerifySignature(appCertificate string) bool {
	if p == nil || !agoraHex32Re.MatchString(p.AppID) || !agoraHex32Re.MatchString(appCertificate) {
		return false
	}
	if len(p.signature) == 0 || len(p.signingInfo) == 0 {
		return false
	}
	signing := deriveAccessToken2SigningKey(appCertificate, p.IssueTs, p.Salt)
	expected := hmacSHA256(signing, p.signingInfo)
	return hmac.Equal(p.signature, expected)
}

func deriveAccessToken2SigningKey(appCertificate string, issueTs, salt uint32) []byte {
	var tsBuf [4]byte
	binary.LittleEndian.PutUint32(tsBuf[:], issueTs)
	signing := hmacSHA256(tsBuf[:], []byte(appCertificate))

	var saltBuf [4]byte
	binary.LittleEndian.PutUint32(saltBuf[:], salt)
	return hmacSHA256(saltBuf[:], signing)
}

func hmacSHA256(key, msg []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(msg)
	return mac.Sum(nil)
}

func randomSalt() (uint32, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(99_999_999))
	if err != nil {
		return 0, err
	}
	return uint32(n.Int64()) + 1, nil
}

type byteWriter struct {
	buf []byte
}

func (w *byteWriter) putUint16(v uint16) {
	var b [2]byte
	binary.LittleEndian.PutUint16(b[:], v)
	w.buf = append(w.buf, b[:]...)
}

func (w *byteWriter) putUint32(v uint32) {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], v)
	w.buf = append(w.buf, b[:]...)
}

func (w *byteWriter) putBytes(data []byte) {
	w.putUint16(uint16(len(data)))
	w.buf = append(w.buf, data...)
}

func (w *byteWriter) putString(s string) {
	w.putBytes([]byte(s))
}

func (w *byteWriter) putUint32Map(m map[uint16]uint32) {
	w.putUint16(uint16(len(m)))
	keys := make([]uint16, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		w.putUint16(k)
		w.putUint32(m[k])
	}
}

func (w *byteWriter) writeRaw(raw []byte) {
	w.buf = append(w.buf, raw...)
}

func (w *byteWriter) bytes() []byte {
	return w.buf
}

type byteReader struct {
	buf []byte
	pos int
}

func (r *byteReader) rest() []byte {
	return r.buf[r.pos:]
}

func (r *byteReader) getUint16() (uint16, error) {
	if r.pos+2 > len(r.buf) {
		return 0, io.ErrUnexpectedEOF
	}
	v := binary.LittleEndian.Uint16(r.buf[r.pos : r.pos+2])
	r.pos += 2
	return v, nil
}

func (r *byteReader) getUint32() (uint32, error) {
	if r.pos+4 > len(r.buf) {
		return 0, io.ErrUnexpectedEOF
	}
	v := binary.LittleEndian.Uint32(r.buf[r.pos : r.pos+4])
	r.pos += 4
	return v, nil
}

func (r *byteReader) getBytes() ([]byte, error) {
	n, err := r.getUint16()
	if err != nil {
		return nil, err
	}
	if r.pos+int(n) > len(r.buf) {
		return nil, io.ErrUnexpectedEOF
	}
	out := slices.Clone(r.buf[r.pos : r.pos+int(n)])
	r.pos += int(n)
	return out, nil
}

func (r *byteReader) getString() (string, error) {
	b, err := r.getBytes()
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (r *byteReader) getUint32Map() (map[uint16]uint32, error) {
	n, err := r.getUint16()
	if err != nil {
		return nil, err
	}
	out := make(map[uint16]uint32, n)
	for range n {
		k, err := r.getUint16()
		if err != nil {
			return nil, err
		}
		v, err := r.getUint32()
		if err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, nil
}
