package channels

import (
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// The yard gate (院门): other devices on the local network (a phone, another Mac) using this farm. The farm itself
// keeps listening on loopback alone; the gate is a second listener on every interface (VIBEVALLEY_LAN_PORT, default
// 8790), shut until the owner opens it, and it stays as the owner left it across restarts. Through it go VibeValleyApi
// and the site streams (apiMux), never /mcp or the page, and only with a paired device's key: helpers run commands
// on this machine without asking. Opening it, pairing and forgetting devices are this machine's alone.
//
// Pairing: the owner asks for a code (good once, for two minutes) and shows it as a QR code or a link; the device
// sends it with its name and waits; the owner allows or refuses it here. Allowed, the device gets a key of its own
// (the database keeps only its SHA-256) and sends it as a bearer token. Forgetting a device ends its requests at once.
// The gate speaks plain HTTP: a key can be overheard on the network it is open on.
// Rationale: .agents/notes/implemented/feature/2026-10-14-yard-gate.md.

const (
	// lanPairingFor: a new code is good this long; a device's asking gets as long again for the owner to answer.
	lanPairingFor = 2 * time.Minute
	// lanWrongTries: this many wrong codes and the pairing is called off.
	lanWrongTries = 5
	// lanSeenEvery: a device's last visit is written down at most this often.
	lanSeenEvery = time.Minute
)

type lanDevice struct {
	protocol.LanDevice
	keyHash string
	// written is when lastSeen was last written down.
	written int64
}

type lanPairing struct {
	code    string
	expires time.Time
	// asking is the name of the device waiting for the owner; answer gets the owner's word, once.
	asking string
	answer chan bool
	wrong  int
}

// lanDeviceKey is the context key of the device a request came through the gate with.
type lanDeviceKey struct{}

type Lan struct {
	db *sql.DB
	// API is what the gate lets through (the handler package's apiMux): handler.New hands it over before the farm
	// starts, since the API answers for every service, the gate's own pages included.
	API http.Handler
	// host and port are where the gate listens: every interface unless a test says otherwise; port 0 is any.
	host string
	port int
	// address is this machine's address on the local network, as a device reaches it; tests replace it.
	address func() string
	now     func() time.Time
	ctx     context.Context

	mu       sync.Mutex
	open     bool
	server   *http.Server
	listener net.Listener
	problem  string
	pairing  *lanPairing
	devices  map[string]*lanDevice // by id
	// conns are the requests under way, per device: forgetting a device ends them.
	conns map[string]map[int]context.CancelFunc
	next  int
}

func newLan(db *sql.DB) (*Lan, error) {
	port := 8790
	if v := os.Getenv("VIBEVALLEY_LAN_PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 65535 {
			return nil, fmt.Errorf("VIBEVALLEY_LAN_PORT 不是端口：%s", v)
		}
		port = n
	}
	l := &Lan{db: db, port: port, address: lanAddress, now: time.Now, devices: map[string]*lanDevice{}, conns: map[string]map[int]context.CancelFunc{}}
	rows, err := db.Query(`select id, name, key_hash, paired_at, last_seen from lan_devices`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		d := &lanDevice{}
		var seen sql.NullInt64
		if err := rows.Scan(&d.ID, &d.Name, &d.keyHash, &d.PairedAt, &seen); err != nil {
			return nil, err
		}
		if seen.Valid {
			d.LastSeen, d.written = &seen.Int64, seen.Int64
		}
		l.devices[d.ID] = d
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var open int
	if err := db.QueryRow(`select open from lan_gate where id = 1`).Scan(&open); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	l.open = open == 1
	return l, nil
}

// start opens the gate when the owner left it open.
func (l *Lan) OnStart(ctx context.Context) error {
	l.ctx = ctx
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open {
		l.listen()
	}
	return nil
}

func (l *Lan) OnStop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.shut()
}

// listen starts the gate's listener; a port taken is said in the status, the farm runs on. Holds mu.
func (l *Lan) listen() {
	if l.server != nil {
		return
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(l.host, strconv.Itoa(l.port)))
	if err != nil {
		l.problem = "院门开不起来：" + err.Error()
		log.Printf("vibevalley: the yard gate cannot listen on port %d: %v", l.port, err)
		return
	}
	l.problem = ""
	l.listener = listener
	ctx := l.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	l.server = &http.Server{
		Handler:           l.gate(l.API),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go l.server.Serve(listener)
	log.Printf("vibevalley: the yard gate is open on %s", listener.Addr())
}

// shut closes the listener and every request through it, and calls off a pairing. Holds mu.
func (l *Lan) shut() {
	l.dropPairing()
	if l.server != nil {
		l.server.Close()
		log.Printf("vibevalley: the yard gate is shut")
	}
	l.server, l.listener = nil, nil
}

// SetOpen opens or shuts the gate, and remembers which.
func (l *Lan) SetOpen(open bool) (protocol.LanStatus, error) {
	flag := 0
	if open {
		flag = 1
	}
	if _, err := l.db.Exec(`insert into lan_gate (id, open) values (1, ?) on conflict (id) do update set open = excluded.open`, flag); err != nil {
		return protocol.LanStatus{}, err
	}
	l.mu.Lock()
	l.open = open
	if open {
		l.listen()
	} else {
		l.problem = ""
		l.shut()
	}
	l.mu.Unlock()
	return l.Status(), nil
}

// Status is the gate as the owner sees it: where it answers, the pairing under way, the devices.
func (l *Lan) Status() protocol.LanStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := protocol.LanStatus{Open: l.open, Farm: lanFarmName(), Devices: []protocol.LanDevice{}}
	if l.problem != "" {
		s.Problem = &l.problem
	}
	gate := l.url()
	if l.open && l.listener != nil {
		if gate == "" {
			s.Problem = lanPtr("找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试")
		} else {
			s.URL = &gate
		}
	}
	if p := l.livePairing(); p != nil && gate != "" {
		s.Pairing = &protocol.LanPairing{Code: p.code, Link: lanPairLink(gate, p.code), ExpiresAt: p.expires.UnixMilli()}
		if p.asking != "" {
			s.Pairing.Asking = lanPtr(p.asking)
		}
	}
	for _, d := range l.devices {
		s.Devices = append(s.Devices, d.LanDevice)
	}
	slices.SortFunc(s.Devices, func(a, b protocol.LanDevice) int { return cmp.Compare(a.PairedAt, b.PairedAt) })
	return s
}

// url is the gate's address on the local network; empty when it is not listening or the machine has none. Holds mu.
func (l *Lan) url() string {
	if l.listener == nil {
		return ""
	}
	host := l.address()
	if host == "" {
		return ""
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(l.listener.Addr().(*net.TCPAddr).Port))
}

// lanPairLink is what the QR code encodes and a Mac pastes.
func lanPairLink(gate, code string) string {
	return "vibevalley://pair?u=" + url.QueryEscape(gate) + "&c=" + url.QueryEscape(code)
}

// livePairing is the pairing under way, nil once it expired. Holds mu.
func (l *Lan) livePairing() *lanPairing {
	if l.pairing != nil && !l.now().Before(l.pairing.expires) {
		l.dropPairing()
	}
	return l.pairing
}

// dropPairing calls off the pairing under way: a device waiting on it is refused. Holds mu.
func (l *Lan) dropPairing() {
	if l.pairing != nil && l.pairing.asking != "" {
		l.pairing.answer <- false
	}
	l.pairing = nil
}

// StartPairing makes a new pairing code, calling off any earlier one.
func (l *Lan) StartPairing() (protocol.LanStatus, error) {
	l.mu.Lock()
	if !l.open || l.listener == nil {
		l.mu.Unlock()
		return protocol.LanStatus{}, protocol.LanRefused{Reason: "院门还没开：先打开它"}
	}
	if l.url() == "" {
		l.mu.Unlock()
		return protocol.LanStatus{}, protocol.LanRefused{Reason: "找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试"}
	}
	l.dropPairing()
	l.pairing = &lanPairing{code: base.Code(10), expires: l.now().Add(lanPairingFor), answer: make(chan bool, 1)}
	l.mu.Unlock()
	return l.Status(), nil
}

func (l *Lan) StopPairing() protocol.LanStatus {
	l.mu.Lock()
	l.dropPairing()
	l.mu.Unlock()
	return l.Status()
}

// Answer is the owner's word on the device asking; the code is used up either way.
func (l *Lan) Answer(allow bool) (protocol.LanStatus, error) {
	l.mu.Lock()
	p := l.livePairing()
	if p == nil || p.asking == "" {
		l.mu.Unlock()
		return protocol.LanStatus{}, protocol.LanRefused{Reason: "没有设备在等你点头"}
	}
	p.answer <- allow
	l.pairing = nil
	l.mu.Unlock()
	return l.Status(), nil
}

// Pair is a device asking with the code: it waits for the owner, then gets its key or why not.
func (l *Lan) Pair(ctx context.Context, code, name string) (protocol.LanPaired, error) {
	name = lanDeviceName(name)
	l.mu.Lock()
	p := l.livePairing()
	switch {
	case !l.open:
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "院门关着：回那台电脑上打开院门"}
	case p == nil:
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "配对码过期了：回那台电脑上换一个码"}
	case subtle.ConstantTimeCompare([]byte(strings.ToUpper(strings.TrimSpace(code))), []byte(p.code)) != 1:
		p.wrong++
		if p.wrong >= lanWrongTries {
			l.dropPairing()
		}
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "配对码不对"}
	case p.asking != "":
		l.mu.Unlock()
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "另一台设备正在等主人点头：等一会儿再试"}
	}
	p.asking = name
	p.expires = l.now().Add(lanPairingFor)
	answer := p.answer
	l.mu.Unlock()
	log.Printf("vibevalley: the yard gate: %q asks to pair", name)

	wait := time.NewTimer(lanPairingFor)
	defer wait.Stop()
	select {
	case allow := <-answer:
		if !allow {
			return protocol.LanPaired{}, protocol.LanRefused{Reason: "主人没让这台设备进来"}
		}
		return l.addDevice(name)
	case <-wait.C:
		l.callOff(p)
		return protocol.LanPaired{}, protocol.LanRefused{Reason: "主人没来得及点头，配对码过期了：回那台电脑上换一个码"}
	case <-ctx.Done():
		l.callOff(p)
		return protocol.LanPaired{}, ctx.Err()
	}
}

// callOff ends a pairing whose device stopped waiting, unless the owner has answered or a new one replaced it.
func (l *Lan) callOff(p *lanPairing) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.pairing == p {
		l.pairing = nil
	}
}

func (l *Lan) addDevice(name string) (protocol.LanPaired, error) {
	key := lanKey()
	d := &lanDevice{LanDevice: protocol.LanDevice{ID: "d" + base.Code(8), Name: name, PairedAt: l.now().UnixMilli()}, keyHash: lanHash(key)}
	if _, err := l.db.Exec(`insert into lan_devices (id, name, key_hash, paired_at) values (?, ?, ?, ?)`, d.ID, d.Name, d.keyHash, d.PairedAt); err != nil {
		return protocol.LanPaired{}, err
	}
	l.mu.Lock()
	l.devices[d.ID] = d
	l.mu.Unlock()
	log.Printf("vibevalley: the yard gate: %q paired", name)
	return protocol.LanPaired{Device: d.ID, Key: key, Farm: lanFarmName()}, nil
}

// Forget removes a device: its key stops working and its requests under way end.
func (l *Lan) Forget(id string) (protocol.LanStatus, error) {
	if _, err := l.db.Exec(`delete from lan_devices where id = ?`, id); err != nil {
		return protocol.LanStatus{}, err
	}
	l.mu.Lock()
	delete(l.devices, id)
	for _, cancel := range l.conns[id] {
		cancel()
	}
	delete(l.conns, id)
	l.mu.Unlock()
	return l.Status(), nil
}

// Me is the device a request came through the gate with.
func (l *Lan) Me(ctx context.Context) (protocol.LanDevice, error) {
	id, _ := ctx.Value(lanDeviceKey{}).(string)
	l.mu.Lock()
	defer l.mu.Unlock()
	if d := l.devices[id]; d != nil {
		return d.LanDevice, nil
	}
	return protocol.LanDevice{}, protocol.LanRefused{Reason: "这里就是农场本机，不是经院门来的设备"}
}

// gate is what the gate's listener answers: a pairing request without a key, else a known device's key, and then
// only VibeValleyApi and the site streams, not the gate's own settings.
func (l *Lan) gate(inner http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if r.Method == http.MethodPost && path == "/api/lan/pair" {
			inner.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(path, "/api/") {
			http.NotFound(w, r)
			return
		}
		d := l.deviceOf(r.Header.Get("Authorization"))
		if d == "" {
			lanRefuse(w, http.StatusUnauthorized, "这台设备没配对，或者已经被主人移除了：回那台电脑上扫码配对")
			return
		}
		if (path == "/api/lan" || strings.HasPrefix(path, "/api/lan/")) && path != "/api/lan/me" {
			lanRefuse(w, http.StatusForbidden, "院门只能在农场那台电脑上管")
			return
		}
		ctx, done := l.track(r.Context(), d)
		defer done()
		inner.ServeHTTP(w, r.WithContext(context.WithValue(ctx, lanDeviceKey{}, d)))
	})
}

// deviceOf is the device whose key the header carries, its visit noted; empty for none.
func (l *Lan) deviceOf(header string) string {
	key, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || key == "" {
		return ""
	}
	hash := lanHash(key)
	now := l.now().UnixMilli()
	l.mu.Lock()
	var found *lanDevice
	for _, d := range l.devices {
		if subtle.ConstantTimeCompare([]byte(d.keyHash), []byte(hash)) == 1 {
			found = d
		}
	}
	if found == nil {
		l.mu.Unlock()
		return ""
	}
	found.LastSeen = &now
	write := now-found.written >= lanSeenEvery.Milliseconds()
	if write {
		found.written = now
	}
	id := found.ID
	l.mu.Unlock()
	if write {
		if _, err := l.db.Exec(`update lan_devices set last_seen = ? where id = ?`, now, id); err != nil {
			log.Printf("vibevalley: the yard gate: %v", err)
		}
	}
	return id
}

// track keeps a request's cancel under its device until it ends.
func (l *Lan) track(ctx context.Context, device string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	l.mu.Lock()
	l.next++
	n := l.next
	if l.conns[device] == nil {
		l.conns[device] = map[int]context.CancelFunc{}
	}
	l.conns[device][n] = cancel
	l.mu.Unlock()
	return ctx, func() {
		cancel()
		l.mu.Lock()
		delete(l.conns[device], n)
		l.mu.Unlock()
	}
}

func lanRefuse(w http.ResponseWriter, status int, reason string) {
	body, _ := json.Marshal(protocol.LanRefused{Reason: reason})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(body)
}

// lanAddress is this machine's private IPv4 address on the local network: Wi-Fi or Ethernet (en*, eth*, wlan*)
// before others; empty when it has none.
func lanAddress() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	best, rank := "", 3
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		r := 2
		for _, p := range []string{"en", "eth", "wlan", "wl"} {
			if strings.HasPrefix(iface.Name, p) {
				r = 1
			}
		}
		if r >= rank {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() {
				best, rank = n.IP.String(), r
				break
			}
		}
	}
	return best
}

// lanFarmName is this machine's name, as a device shows the farm.
func lanFarmName() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "vibevalley"
	}
	return strings.TrimSuffix(name, ".local")
}

// lanDeviceName is the name a device gave, tidied: one line, at most 40 characters.
func lanDeviceName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	if r := []rune(name); len(r) > 40 {
		name = string(r[:40])
	}
	if name == "" {
		return "一台设备"
	}
	return name
}

func lanKey() string {
	raw := make([]byte, 32)
	rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func lanHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func lanPtr[T any](v T) *T { return &v }
