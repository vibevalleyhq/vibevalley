package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type userDeviceView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Came string `json:"came"`
}

type userStatusView struct {
	Name          string          `json:"name"`
	Password      bool            `json:"password"`
	Here          bool            `json:"here"`
	Authenticated bool            `json:"authenticated"`
	Device        *userDeviceView `json:"device,omitempty"`
}

type userLoginView struct {
	Device string `json:"device"`
	Key    string `json:"key"`
	Token  string `json:"token"`
}

type approvalCreatedView struct {
	Code      string  `json:"code"`
	Claim     string  `json:"claim"`
	ExpiresAt int64   `json:"expiresAt"`
	Every     float64 `json:"every"`
}

type approvalCollectedView struct {
	Login *userLoginView `json:"login,omitempty"`
	Every *float64       `json:"every,omitempty"`
}

func defaultDeviceName() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		return "vibe-cli"
	}
	return strings.TrimSuffix(strings.TrimSpace(host), ".local")
}

func newAuthCommand(rt *appRuntime) *cobra.Command {
	authCmd := &cobra.Command{
		Use:   "auth",
		Short: "Authenticate CLI sessions with a VibeValley server",
	}

	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show current authentication status",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, env, err := rt.newClient()
			if err != nil {
				return err
			}
			saved, hasSaved, _ := readCLIAuth(env.HomeDir)
			if env.Token == "" && (!hasSaved || saved.Token == "") {
				payload := map[string]any{
					"signedIn": false,
					"server":   env.ServerURL,
					"source":   env.TokenSource,
				}
				return rt.writeOutput(payload, func() string {
					return fmt.Sprintf("not signed in to %s", env.ServerURL)
				})
			}

			var status userStatusView
			if _, err := client.CallWithFallback(cmd.Context(), "user.get", "user.status", nil, nil, &status); err != nil {
				return err
			}
			signedIn := status.Device != nil || status.Authenticated || status.Here || env.Token != ""
			revoked := hasSaved && saved.Token != "" && status.Device == nil && !status.Here && !status.Authenticated
			if revoked {
				signedIn = false
			}
			payload := map[string]any{
				"signedIn": signedIn,
				"revoked":  revoked,
				"server":   env.ServerURL,
				"name":     status.Name,
				"here":     status.Here,
				"source":   env.TokenSource,
			}
			if status.Device != nil {
				payload["device"] = status.Device
			}
			return rt.writeOutput(payload, func() string {
				if revoked {
					return fmt.Sprintf("token revoked for %s", env.ServerURL)
				}
				if !signedIn {
					return fmt.Sprintf("not signed in to %s", env.ServerURL)
				}
				dev := ""
				if status.Device != nil && status.Device.Name != "" {
					dev = " (" + status.Device.Name + ")"
				}
				if status.Name != "" {
					return fmt.Sprintf("signed in to %s as %s%s", env.ServerURL, status.Name, dev)
				}
				return fmt.Sprintf("signed in to %s%s", env.ServerURL, dev)
			})
		},
	}

	var (
		loginPassword string
		loginDevice   string
	)
	loginCmd := &cobra.Command{
		Use:   "login [server]",
		Short: "Sign in to a VibeValley server and persist cli-auth.json",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, env, err := rt.newClient()
			if err != nil {
				return err
			}
			base := env.ServerURL
			if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
				base = normalizeBaseURL(args[0])
				client.BaseURL = base
			}
			devName := strings.TrimSpace(loginDevice)
			if devName == "" {
				devName = defaultDeviceName()
			}

			// Direct token verification & storage when --token or VIBEVALLEY_TOKEN was explicitly provided.
			if env.Token != "" && (env.TokenSource == "flag" || env.TokenSource == "VIBEVALLEY_TOKEN") {
				var st userStatusView
				if _, err := client.CallWithFallback(cmd.Context(), "user.get", "user.status", nil, nil, &st); err != nil {
					return err
				}
				devID := devName
				if st.Device != nil && st.Device.ID != "" {
					devID = st.Device.ID
				}
				if err := writeCLIAuth(env.HomeDir, CLIAuthState{
					Server: base,
					Token:  env.Token,
					Device: devID,
					User:   st.Name,
				}); err != nil {
					return err
				}
				return rt.writeOutput(
					map[string]any{"signedIn": true, "server": base, "device": devID, "name": st.Name},
					func() string { return fmt.Sprintf("signed in to %s (%s)", base, devName) },
				)
			}

			// Password login when --password is supplied.
			if loginPassword != "" {
				var res userLoginView
				if _, err := client.Call(cmd.Context(), "user.login", map[string]string{
					"password": loginPassword,
					"device":   devName,
				}, &res); err != nil {
					return err
				}
				tok := res.Key
				if tok == "" {
					tok = res.Token
				}
				if err := writeCLIAuth(env.HomeDir, CLIAuthState{
					Server: base,
					Token:  tok,
					Device: res.Device,
				}); err != nil {
					return err
				}
				return rt.writeOutput(
					map[string]any{"signedIn": true, "server": base, "device": res.Device},
					func() string { return fmt.Sprintf("signed in to %s (%s)", base, devName) },
				)
			}

			var initial userStatusView
			if _, err := client.CallWithFallback(cmd.Context(), "user.get", "user.status", nil, nil, &initial); err != nil {
				return err
			}
			if initial.Here {
				return rt.writeOutput(
					map[string]any{"server": base, "here": true, "signedIn": true},
					func() string { return fmt.Sprintf("already authorized on local server %s", base) },
				)
			}

			var created approvalCreatedView
			if _, err := client.Call(cmd.Context(), "user.approval.create", map[string]string{"name": devName}, &created); err != nil {
				return err
			}
			approveURL := strings.TrimRight(base, "/") + "/approve?code=" + url.QueryEscape(created.Code)
			fmt.Fprintf(rt.stderr, "Approve CLI login with code %s at %s\n", created.Code, approveURL)

			every := created.Every
			if every <= 0 {
				every = 1
			}
			var collected approvalCollectedView
			for {
				if _, err := client.Call(cmd.Context(), "user.approval.collect", map[string]string{"claim": created.Claim}, &collected); err != nil {
					return err
				}
				if collected.Login != nil {
					break
				}
				if collected.Every != nil && *collected.Every > 0 {
					every = *collected.Every
				}
				wait := time.Duration(every * float64(time.Second))
				if wait < 5*time.Millisecond {
					wait = 5 * time.Millisecond
				}
				timer := time.NewTimer(wait)
				select {
				case <-cmd.Context().Done():
					timer.Stop()
					return cmd.Context().Err()
				case <-timer.C:
				}
			}

			tok := collected.Login.Key
			if tok == "" {
				tok = collected.Login.Token
			}
			client.Token = tok
			if err := writeCLIAuth(env.HomeDir, CLIAuthState{
				Server: base,
				Token:  tok,
				Device: collected.Login.Device,
			}); err != nil {
				return err
			}

			var me userStatusView
			_, _ = client.CallWithFallback(cmd.Context(), "user.get", "user.status", nil, nil, &me)
			if me.Name != "" {
				_ = writeCLIAuth(env.HomeDir, CLIAuthState{
					Server: base,
					Token:  tok,
					Device: collected.Login.Device,
					User:   me.Name,
				})
			}

			return rt.writeOutput(
				map[string]any{
					"signedIn": true,
					"server":   base,
					"device":   collected.Login.Device,
					"name":     me.Name,
				},
				func() string { return fmt.Sprintf("signed in to %s as %s", base, devName) },
			)
		},
	}
	loginCmd.Flags().StringVar(&loginPassword, "password", "", "sign in with password instead of approval code")
	loginCmd.Flags().StringVar(&loginDevice, "device", "", "device name registered on server")

	logoutCmd := &cobra.Command{
		Use:   "logout",
		Short: "Revoke stored CLI credentials and remove cli-auth.json",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, env, err := rt.newClient()
			if err != nil {
				return err
			}
			saved, hasSaved, _ := readCLIAuth(env.HomeDir)
			if !hasSaved && env.Token == "" {
				return rt.writeOutput(
					map[string]any{"signedIn": false, "server": env.ServerURL},
					func() string { return fmt.Sprintf("not signed in to %s", env.ServerURL) },
				)
			}
			if saved.Server != "" {
				client.BaseURL = saved.Server
			}
			if client.Token == "" {
				client.Token = saved.Token
			}
			if client.Token != "" {
				if _, err := client.Call(cmd.Context(), "user.logout", nil, nil); err != nil {
					fmt.Fprintf(rt.stderr, "warning: server logout failed: %v\n", err)
				}
			}
			if err := removeCLIAuth(env.HomeDir); err != nil {
				return err
			}
			serverOut := env.ServerURL
			if saved.Server != "" {
				serverOut = saved.Server
			}
			return rt.writeOutput(
				map[string]any{"signedIn": false, "server": serverOut},
				func() string { return fmt.Sprintf("signed out of %s", serverOut) },
			)
		},
	}

	authCmd.AddCommand(statusCmd, loginCmd, logoutCmd)
	return authCmd
}
