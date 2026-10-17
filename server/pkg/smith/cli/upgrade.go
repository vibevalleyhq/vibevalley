package cli

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"vibevalley/pkg/smith/oar"
)

// upgradeReport is one `oar upgrade` row.
type upgradeReport struct {
	RuntimeID    string                    `json:"runtimeId"`
	Installation *oar.InstallationSnapshot `json:"installation,omitempty"`
	Check        *oar.UpdateCheck          `json:"check,omitempty"`
	Upgrade      *oar.UpgradeResult        `json:"upgrade,omitempty"`
	Unsupported  string                    `json:"unsupported,omitempty"`
	Error        string                    `json:"error,omitempty"`
}

func readUpgrade(ctx context.Context, runtime oar.Runtime, upgrade bool, timeout int64) (report upgradeReport) {
	report.RuntimeID = runtime.ID
	defer func() {
		if recovered := recover(); recovered != nil {
			report = upgradeReport{RuntimeID: runtime.ID, Error: fmt.Sprint(recovered)}
		}
	}()
	fail := func(err error) upgradeReport { return upgradeReport{RuntimeID: runtime.ID, Error: err.Error()} }
	if runtime.Installation == nil {
		report.Unsupported = runtime.ID + " exposes no installation probe"
		return report
	}
	installation, err := runtime.Installation(ctx)
	if err != nil {
		return fail(err)
	}
	if installation.Kind != "available" {
		report.Installation = &installation
		return report
	}
	if runtime.CheckUpdate == nil {
		report.Unsupported = runtime.ID + " exposes no update check"
		if installation.Available.Via == "bundled" {
			report.Unsupported = runtime.ID + " is bundled with oar and moves with the oar version"
		}
		return report
	}
	checkOptions := oar.UpdateCheckOptions{Timeout: millis(timeout)}
	if !upgrade || runtime.Upgrade == nil {
		check, err := runtime.CheckUpdate(ctx, installation.Available, checkOptions)
		if err != nil {
			return fail(err)
		}
		report.Check = &check
		if upgrade {
			report.Unsupported = runtime.ID + " has no updater oar can run"
		}
		return report
	}
	result, err := runtime.Upgrade(ctx, installation.Available, oar.UpgradeOptions{Timeout: millis(timeout)})
	if err != nil {
		return fail(err)
	}
	report.Upgrade = &result
	return report
}

func renderCheck(runtimeID string, check oar.UpdateCheck) string {
	if check.Kind == "unavailable" {
		detail := ""
		if check.Detail != "" {
			detail = " (" + check.Detail + ")"
		}
		return fmt.Sprintf("%s\tcheck unavailable: %s%s", runtimeID, check.Reason, detail)
	}
	var notes []string
	if check.Channel != "" {
		notes = append(notes, check.Channel+" channel")
	}
	notes = append(notes, check.Source)
	state := check.Installed + " current"
	if check.UpdateAvailable {
		state = fmt.Sprintf("%s -> %s available", check.Installed, check.Latest)
	} else if check.Latest != check.Installed {
		state = check.Installed + ", no update"
		notes = append([]string{"source lists " + check.Latest}, notes...)
	}
	return fmt.Sprintf("%s\t%s (%s)", runtimeID, state, strings.Join(notes, ", "))
}

var lineBreak = regexp.MustCompile(`\r?\n`)

func outputTail(output string) []string {
	var lines []string
	for _, line := range lineBreak.Split(strings.TrimSpace(output), -1) {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, "  "+line)
		}
	}
	if len(lines) > 20 {
		lines = lines[len(lines)-20:]
	}
	return lines
}

func renderUpgrade(runtimeID string, upgrade oar.UpgradeResult) []string {
	output := ""
	if upgrade.Output != nil {
		output = *upgrade.Output
	}
	switch upgrade.Kind {
	case "upgraded":
		return []string{fmt.Sprintf("%s\tupgraded %s -> %s", runtimeID, upgrade.From, upgrade.To)}
	case "current":
		if upgrade.Check != nil {
			return []string{renderCheck(runtimeID, *upgrade.Check)}
		}
	case "unchanged":
		return append([]string{fmt.Sprintf("%s\tstill %s after the updater ran; its output:", runtimeID, upgrade.Version)}, outputTail(output)...)
	case "failed":
		code := "none"
		if upgrade.ExitCode != nil && upgrade.ExitCode.Valid {
			code = fmt.Sprint(upgrade.ExitCode.Int)
		}
		return append([]string{fmt.Sprintf("%s\tupgrade failed (exit %s); its output:", runtimeID, code)}, outputTail(output)...)
	}
	detail := ""
	if upgrade.Detail != "" {
		detail = " (" + upgrade.Detail + ")"
	}
	return []string{fmt.Sprintf("%s\tupgrade unsupported: %s%s", runtimeID, upgrade.Reason, detail)}
}

func renderUpgradeReport(report upgradeReport) []string {
	if report.Error != "" {
		return []string{fmt.Sprintf("%s\terror: %s", report.RuntimeID, report.Error)}
	}
	if report.Installation != nil {
		return []string{fmt.Sprintf("%s\tnot available (%s)", report.RuntimeID, report.Installation.Kind)}
	}
	var lines []string
	if report.Check != nil {
		lines = append(lines, renderCheck(report.RuntimeID, *report.Check))
	}
	if report.Upgrade != nil {
		lines = append(lines, renderUpgrade(report.RuntimeID, *report.Upgrade)...)
	}
	if report.Unsupported != "" {
		lines = append(lines, report.RuntimeID+"\t"+report.Unsupported)
	}
	return lines
}

func upgradeFailed(report upgradeReport) bool {
	return report.Error != "" || (report.Upgrade != nil && (report.Upgrade.Kind == "failed" || report.Upgrade.Kind == "unchanged"))
}

func (c *cli) upgrade(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, []string{"timeout"}, []string{"check", "json"})
	if err != nil {
		return err
	}
	timeout, _, err := parsed.positiveMs("timeout")
	if err != nil {
		fmt.Fprintln(c.stderr, err.Error())
		c.exitCode = 1
		return nil
	}
	id, _ := parsed.arg(0)
	runtimes, err := c.selected(id)
	if err != nil {
		return err
	}
	upgrade := !parsed.flag("check")
	reports := make([]upgradeReport, 0, len(runtimes))
	if upgrade {
		// One updater at a time: each may download hundreds of megabytes.
		for _, runtime := range runtimes {
			reports = append(reports, readUpgrade(ctx, runtime, true, timeout))
		}
	} else {
		for _, report := range readEach(runtimes, func(runtime oar.Runtime) (any, error) {
			return readUpgrade(ctx, runtime, false, timeout), nil
		}) {
			reports = append(reports, report.(upgradeReport))
		}
	}
	for _, report := range reports {
		if upgradeFailed(report) {
			c.exitCode = 1
		}
	}
	if parsed.flag("json") {
		fmt.Fprint(c.stdout, pretty(reports))
		return nil
	}
	for _, report := range reports {
		for _, line := range renderUpgradeReport(report) {
			fmt.Fprintln(c.stdout, line)
		}
	}
	return nil
}
