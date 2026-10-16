package pi

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// The Go port drives pi through host/pi-host.mjs: pi's own SDK, loaded from
// the pi the user installed and opened the way the TS package opens it
// in process. pi is a Node program, so the host needs nothing pi does not.

//go:embed host/pi-host.mjs
var hostScript []byte

const sdkPackage = "@earendil-works/pi-coding-agent"

var hostFile = struct {
	sync.Mutex
	path string
}{}

// hostPath writes the embedded host script once per process.
func hostPath() (string, error) {
	hostFile.Lock()
	defer hostFile.Unlock()
	if hostFile.path != "" {
		if _, err := os.Stat(hostFile.path); err == nil {
			return hostFile.path, nil
		}
	}
	dir, err := shared.NewPrivateTempDir("oar-pi-host-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir.Path, "pi-host.mjs")
	if err := os.WriteFile(path, hostScript, 0o600); err != nil {
		return "", err
	}
	hostFile.path = path
	return path, nil
}

func isSDKRoot(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var manifest struct {
		Name string `json:"name"`
	}
	return json.Unmarshal(data, &manifest) == nil && manifest.Name == sdkPackage
}

// SDKRoot is the pi-coding-agent package the pi executable runs:
// OAR_PI_SDK_DIR when set, else found from the executable's real path (an npm
// bin links into the package) or beside a node_modules/.bin shim.
func SDKRoot(command string) (string, error) {
	if pinned := os.Getenv("OAR_PI_SDK_DIR"); pinned != "" {
		if isSDKRoot(pinned) {
			return pinned, nil
		}
		return "", fmt.Errorf("OAR_PI_SDK_DIR %s is not the %s package", pinned, sdkPackage)
	}
	var candidates []string
	if real, err := filepath.EvalSymlinks(command); err == nil {
		for dir := filepath.Dir(real); ; dir = filepath.Dir(dir) {
			candidates = append(candidates, dir)
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}
	// node_modules/.bin/pi as a shell shim (pnpm): the package is node_modules/@earendil-works/pi-coding-agent.
	candidates = append(candidates, filepath.Join(filepath.Dir(command), "..", "@earendil-works", "pi-coding-agent"))
	for _, candidate := range candidates {
		if isSDKRoot(candidate) {
			if real, err := filepath.EvalSymlinks(candidate); err == nil {
				return real, nil
			}
			return candidate, nil
		}
	}
	return "", fmt.Errorf("cannot find the %s package of %s (set OAR_PI_SDK_DIR)", sdkPackage, command)
}

// nodeCommand is the Node that runs the host: OAR_PI_NODE, else `node` on PATH.
func nodeCommand() string {
	if pinned := os.Getenv("OAR_PI_NODE"); pinned != "" {
		return pinned
	}
	return "node"
}

// startHost starts the host for the pi installation and sends its job.
func startHost(installation oar.AvailableInstallation, cwd string) (*executable.LineProcess, *rpcClient, error) {
	root, err := SDKRoot(installation.Command)
	if err != nil {
		return nil, nil, err
	}
	script, err := hostPath()
	if err != nil {
		return nil, nil, err
	}
	process, err := executable.Spawn(nodeCommand(), []string{script, root}, executable.LineOptions{Dir: cwd, KillTree: true})
	if err != nil {
		return nil, nil, err
	}
	return process, newRPCClient(process), nil
}

// hostJob runs one short host job (models, inventory) and returns its answer.
func hostJob(ctx context.Context, installation oar.AvailableInstallation, cwd string, timeout time.Duration, job jsonx.Record) (json.RawMessage, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	process, client, err := startHost(installation, cwd)
	if err != nil {
		return nil, err
	}
	go func() {
		for !client.take().exit {
		}
	}()
	defer func() {
		process.CloseStdin()
		select {
		case <-process.Exited():
		case <-time.After(5 * time.Second):
			process.Kill()
			<-process.Exited()
		}
	}()
	data, err := client.request(ctx, job)
	if errors.Is(err, errExited) {
		return nil, executable.ProcessFailure("the pi host exited", process.Diagnostics())
	}
	return data, err
}
