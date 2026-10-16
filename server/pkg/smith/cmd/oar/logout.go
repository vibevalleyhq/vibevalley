package main

import (
	"context"
	"fmt"

	"vibevalley/pkg/smith/oar"
)

type logoutReport struct {
	RuntimeID    string                    `json:"runtimeId"`
	Installation *oar.InstallationSnapshot `json:"installation,omitempty"`
	Result       *oar.LogoutResult         `json:"result,omitempty"`
	Unsupported  string                    `json:"unsupported,omitempty"`
	Error        string                    `json:"error,omitempty"`
}

func runLogout(ctx context.Context, runtime oar.Runtime, timeout int64) logoutReport {
	report := logoutReport{RuntimeID: runtime.ID}
	if runtime.Installation == nil {
		report.Unsupported = runtime.ID + " exposes no installation probe"
		return report
	}
	installation, err := runtime.Installation(ctx)
	if err != nil {
		return logoutReport{RuntimeID: runtime.ID, Error: err.Error()}
	}
	if installation.Kind != "available" {
		report.Installation = &installation
		return report
	}
	if runtime.Logout == nil {
		report.Unsupported = runtime.ID + " has no logout oar can drive"
		return report
	}
	result, err := runtime.Logout(ctx, installation.Available, oar.LogoutOptions{Timeout: millis(timeout)})
	if err != nil {
		return logoutReport{RuntimeID: runtime.ID, Error: err.Error()}
	}
	report.Result = &result
	return report
}

func renderLogoutReport(report logoutReport) string {
	switch {
	case report.Error != "":
		return report.RuntimeID + "\terror: " + report.Error
	case report.Installation != nil:
		return fmt.Sprintf("%s\tnot available (%s)", report.RuntimeID, report.Installation.Kind)
	case report.Result == nil:
		if report.Unsupported == "" {
			return report.RuntimeID + "\tno logout"
		}
		return report.RuntimeID + "\t" + report.Unsupported
	}
	switch report.Result.Kind {
	case "logged_out":
		return report.RuntimeID + "\tlogged out"
	case "failed":
		return withDetail(report.RuntimeID+"\tlogout failed: "+report.Result.Reason, report.Result.Detail)
	}
	return withDetail(report.RuntimeID+"\tlogout unsupported: "+report.Result.Reason, report.Result.Detail)
}

func (c *cli) logout(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, []string{"timeout"}, []string{"json"})
	if err != nil {
		return err
	}
	timeout, _, err := parsed.positiveMs("timeout")
	if err != nil {
		fmt.Fprintln(c.stderr, err.Error())
		c.exitCode = 1
		return nil
	}
	id, named := parsed.arg(0)
	if !named || id == "all" {
		fmt.Fprintln(c.stderr, "name one runtime to sign out, e.g. `oar logout claude`")
		c.exitCode = 1
		return nil
	}
	runtime, err := c.registry.Require(id)
	if err != nil {
		return err
	}
	report := runLogout(ctx, runtime, timeout)
	c.exitCode = 1
	if report.Result != nil && report.Result.Kind == "logged_out" {
		c.exitCode = 0
	}
	if parsed.flag("json") {
		fmt.Fprintln(c.stdout, compact(map[string]any{"result": report}))
	} else {
		fmt.Fprintln(c.stdout, renderLogoutReport(report))
	}
	return nil
}
