package vibevalley_test

import (
	"bytes"
	"encoding/json"
	"io"
	"os/exec"
	"strings"
	"testing"
)

const modulePath = "github.com/vibevalleyhq/vibevalley"

type goListPkg struct {
	ImportPath string   `json:"ImportPath"`
	Name       string   `json:"Name"`
	Standard   bool     `json:"Standard"`
	ForTest    string   `json:"ForTest"`
	Imports    []string `json:"Imports"`
	Deps       []string `json:"Deps"`
}

func runGoList(t *testing.T, args ...string) []goListPkg {
	t.Helper()
	cmd := exec.Command("go", append([]string{"list", "-json"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list %v failed: %v\n%s", args, err, string(out))
	}
	dec := json.NewDecoder(bytes.NewReader(out))
	var pkgs []goListPkg
	for {
		var pkg goListPkg
		if err := dec.Decode(&pkg); err == io.EOF {
			break
		} else if err != nil {
			t.Fatalf("decode go list json: %v", err)
		}
		pkgs = append(pkgs, pkg)
	}
	return pkgs
}

func relPkgPath(importPath string) string {
	return strings.TrimPrefix(strings.TrimPrefix(importPath, modulePath), "/")
}

func isRepoPkg(importPath string) bool {
	return importPath == modulePath || strings.HasPrefix(importPath, modulePath+"/")
}

func subsystemPrefix(rel string) string {
	parts := strings.Split(rel, "/")
	if len(parts) >= 2 && (parts[0] == "pkg" || parts[0] == "internal" || parts[0] == "cmd") {
		return parts[0] + "/" + parts[1]
	}
	return rel
}

func layerRank(rel string) (rank int, ok bool) {
	switch {
	case rel == "pkg/chord" || strings.HasPrefix(rel, "pkg/chord/"):
		return 0, true
	case strings.HasPrefix(rel, "pkg/"):
		return 1, true
	case strings.HasPrefix(rel, "internal/domain/") || rel == "internal/domain":
		return 3, true
	case strings.HasPrefix(rel, "internal/"):
		return 2, true
	case strings.HasPrefix(rel, "cmd/"):
		return 4, true
	default:
		return 0, false
	}
}

func TestArchitectureInvariants(t *testing.T) {
	stdPkgs := map[string]bool{"C": true, "unsafe": true}
	for _, pkg := range runGoList(t, "std") {
		stdPkgs[pkg.ImportPath] = true
	}

	forbiddenSegments := map[string]bool{
		"brain":   true,
		"hands":   true,
		"common":  true,
		"utils":   true,
		"manager": true,
	}
	forbiddenMachineDeps := []string{
		"modernc.org/sqlite",
		"pgx",
		"anthropic",
		"openai",
		"genai",
		modulePath + "/internal/durable",
		modulePath + "/internal/vault",
		"github.com/egoist/mygo",
	}

	for _, pkg := range runGoList(t, "./...") {
		if pkg.ForTest != "" || strings.HasSuffix(pkg.ImportPath, ".test") {
			continue
		}
		rel := relPkgPath(pkg.ImportPath)
		if rel == "" {
			continue
		}

		for seg := range strings.SplitSeq(rel, "/") {
			if forbiddenSegments[seg] {
				t.Errorf("package %q uses forbidden vague or anthropomorphic segment %q", pkg.ImportPath, seg)
			}
		}

		// Gate 1: Strict one-way layering across pkg/chord <- pkg/{contract,oar} <- internal/{durable,vault,machine} <- internal/domain <- cmd/*.
		fromRank, ok := layerRank(rel)
		if !ok {
			t.Errorf("package %q lives outside pkg/, internal/, or cmd/", pkg.ImportPath)
			continue
		}
		fromSubsys := subsystemPrefix(rel)
		for _, imp := range pkg.Imports {
			if !isRepoPkg(imp) {
				continue
			}
			impRel := relPkgPath(imp)
			impRank, impOk := layerRank(impRel)
			if !impOk {
				continue
			}
			impSubsys := subsystemPrefix(impRel)
			if impRank > fromRank {
				t.Errorf("layer violation: %q (layer %d) imports higher layer %q (layer %d)", pkg.ImportPath, fromRank, imp, impRank)
			}
			if impRank == fromRank && impSubsys != fromSubsys && fromRank < 3 {
				t.Errorf("cross-subsystem import at layer %d: %q must not import %q", fromRank, pkg.ImportPath, imp)
			}
		}

		// Gate 2: cmd/vibe-machine purity (no DB drivers, model SDKs, durable, vault, or mygo).
		if rel == "cmd/vibe-machine" || strings.HasPrefix(rel, "cmd/vibe-machine/") {
			for _, dep := range pkg.Deps {
				for _, banned := range forbiddenMachineDeps {
					if dep == banned || strings.Contains(dep, banned) {
						t.Errorf("vibe-machine purity violation: %q transitively depends on %q", pkg.ImportPath, dep)
					}
				}
			}
		}

		// Gate 3: pkg/oar depends strictly on Go standard library + pkg/oar/... itself.
		if rel == "pkg/oar" || strings.HasPrefix(rel, "pkg/oar/") {
			for _, dep := range pkg.Deps {
				if dep == modulePath+"/pkg/oar" || strings.HasPrefix(dep, modulePath+"/pkg/oar/") {
					continue
				}
				if !stdPkgs[dep] {
					t.Errorf("pkg/oar stdlib autonomy violation: %q depends on non-stdlib %q", pkg.ImportPath, dep)
				}
			}
		}

		// Gate 4: github.com/egoist/mygo is isolated strictly to cmd/vibe-desktop.
		if rel != "cmd/vibe-desktop" && !strings.HasPrefix(rel, "cmd/vibe-desktop/") {
			for _, dep := range pkg.Deps {
				if dep == "github.com/egoist/mygo" || strings.HasPrefix(dep, "github.com/egoist/mygo/") {
					t.Errorf("GUI isolation violation: %q depends on %q outside cmd/vibe-desktop", pkg.ImportPath, dep)
				}
			}
		}
	}
}
