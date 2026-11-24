//! `auth login|whoami|status|logout`: manage `$VIBEVALLEY_HOME/auth.json` credentials and inspect remote/local authentication state.

use clap::{Args, Subcommand};
use serde::Serialize;
use vibevalley_protocol::{RemoteDeviceRevokeRequest, RemotePairExchangeRequest, RemotePlatform, SCOPE_REMOTE_CLIENT, ops};

use crate::auth::{self, AuthConfig, Secret, default_device_name, normalize_server_url, parse_pair_url, same_server};
use crate::client::{Client, Done, Failure, TokenSource, no_dry_run};
use crate::output::{line, non_empty_opt};

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct AuthCmd {
    #[command(subcommand)]
    pub action: AuthAction,
}

#[derive(Debug, Subcommand)]
pub enum AuthAction {
    /// Pair with a remote VibeValley server via pairing code, pair URL, or existing Bearer token
    #[command(
        after_help = "Examples:\n  vibevalley auth login http://100.64.0.5:8890 --code ABC234\n  vibevalley auth login --pair-url 'vibevalley://pair?url=http%3A%2F%2F100.64.0.5%3A8890&code=ABC234'\n  vibevalley auth login http://100.64.0.5:8890 --token vv_dev_..."
    )]
    Login {
        /// Remote server base URL (optional when --pair-url or --server is set)
        server_url: Option<String>,
        /// One-time 6-character pairing code from `vibevalley remote code`
        #[arg(long)]
        code: Option<String>,
        /// Pairing deep link (`vibevalley://pair?url=...&code=...`)
        #[arg(long)]
        pair_url: Option<String>,
        /// Device display name recorded on the server (defaults to system hostname or "vibevalley-cli")
        #[arg(long)]
        name: Option<String>,
        /// Requested Bearer token scope (defaults to "remote:default")
        #[arg(long)]
        scope: Option<String>,
    },
    /// Verify active authentication identity and probe server connectivity
    #[command(after_help = "Examples:\n  vibevalley auth whoami\n  vibevalley auth whoami --json")]
    Whoami,
    /// Show active server target, auth mode, stored device info, and connectivity status
    #[command(after_help = "Examples:\n  vibevalley auth status\n  vibevalley auth status --json")]
    Status,
    /// Remove stored credentials from <home>/auth.json (optionally revoking the device first)
    #[command(after_help = "Examples:\n  vibevalley auth logout\n  vibevalley auth logout --revoke")]
    Logout {
        /// Best-effort revoke this paired device on the server before removing local credentials
        #[arg(long)]
        revoke: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthMode {
    RemoteBearer,
    LocalLoopback,
}

impl AuthMode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::RemoteBearer => "remote-bearer",
            Self::LocalLoopback => "local-loopback",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthLoginOutput {
    server: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_name: Option<String>,
    device_id: String,
    device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    auth_file: String,
    token_hint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusReport {
    server: String,
    server_source: &'static str,
    auth_mode: AuthMode,
    token_source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    caller: Option<String>,
    connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    authenticated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthLogoutOutput {
    removed: bool,
    revoked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoke_error: Option<String>,
}

fn format_login(out: &AuthLoginOutput) -> String {
    let mut lines = vec![line(&["server", &out.server, out.server_name.as_deref().unwrap_or("")])];
    lines.push(line(&["device", &out.device_id, &out.device_name]));
    if let Some(scope) = &out.scope {
        lines.push(line(&["scope", scope]));
    }
    lines.push(line(&["token", &out.token_hint]));
    lines.push(line(&["saved", &out.auth_file]));
    lines.join("\n")
}

fn format_status(report: &AuthStatusReport) -> String {
    let mut lines = vec![
        line(&["server", &report.server, report.server_source]),
        line(&[
            "mode",
            report.auth_mode.as_str(),
            if report.token_source == "none" { "" } else { report.token_source },
        ]),
    ];
    if report.device_id.is_some() || report.device_name.is_some() {
        lines.push(line(&[
            "device",
            report.device_id.as_deref().unwrap_or(""),
            report.device_name.as_deref().unwrap_or(""),
        ]));
    }
    if let Some(scope) = &report.scope {
        lines.push(line(&["scope", scope]));
    }
    if let Some(server_name) = &report.server_name {
        lines.push(line(&["server-name", server_name]));
    }
    let version = report.version.as_deref().filter(|v| !v.is_empty()).unwrap_or("");
    if report.connected {
        lines.push(line(&["connectivity", "ok", version]));
    } else {
        lines.push(line(&["connectivity", "unreachable", report.error.as_deref().unwrap_or("")]));
    }
    if let Some(authed) = report.authenticated {
        if authed {
            lines.push(line(&["auth", "ok", report.caller.as_deref().unwrap_or("")]));
        } else {
            lines.push(line(&["auth", "failed", report.error.as_deref().unwrap_or("")]));
        }
    } else if let Some(caller) = &report.caller {
        lines.push(line(&["caller", caller]));
    }
    lines.join("\n")
}

fn format_logout(out: &AuthLogoutOutput) -> String {
    if !out.removed {
        return "already logged out".into();
    }
    if out.revoked {
        return format!("logged out (revoked {})", out.device_id.as_deref().unwrap_or("device"));
    }
    if let Some(err) = &out.revoke_error {
        return format!("logged out (revoke skipped: {err})");
    }
    "logged out".into()
}

fn run_login(client: &Client, server_url: Option<String>, code: Option<String>, pair_url: Option<String>, name: Option<String>, scope: Option<String>) -> Done {
    if client.dry_run {
        return Err(no_dry_run("auth login"));
    }
    if pair_url.is_some() && code.is_some() {
        return Err(Failure::usage("ConflictingOption", "use either --pair-url or --code, not both"));
    }
    if client.flag_token().is_some() && (code.is_some() || pair_url.is_some()) {
        return Err(Failure::usage("ConflictingOption", "use either --token or --code/--pair-url, not both"));
    }

    let requested_name = non_empty_opt(name, "--name")?;
    let requested_scope = non_empty_opt(scope, "--scope")?;

    let saved_config = if let Some(raw_pair_url) = pair_url {
        let parsed = parse_pair_url(&raw_pair_url)?;
        if let Some(explicit_pos) = server_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let normalized = normalize_server_url(explicit_pos)?;
            if !same_server(&normalized, &parsed.server) {
                return Err(Failure::usage(
                    "ConflictingOption",
                    format!("SERVER_URL ({normalized}) conflicts with url inside --pair-url ({})", parsed.server),
                ));
            }
        }
        let device_name = requested_name.unwrap_or_else(default_device_name);
        let scope_value = requested_scope.or(parsed.scope).unwrap_or_else(|| SCOPE_REMOTE_CLIENT.to_string());
        exchange_code(client, parsed.server, parsed.code, device_name, scope_value)?
    } else if let Some(raw_code) = code {
        let code_trimmed = raw_code.trim();
        if code_trimmed.is_empty() {
            return Err(Failure::usage("InvalidValue", "--code must not be empty"));
        }
        let raw_server = server_url
            .filter(|s| !s.trim().is_empty())
            .or_else(|| client.explicit_server().map(ToString::to_string))
            .ok_or_else(|| Failure::usage("MissingArgument", "provide SERVER_URL (or --server / --pair-url) when using --code"))?;
        let server = normalize_server_url(&raw_server)?;
        let device_name = requested_name.unwrap_or_else(default_device_name);
        let scope_value = requested_scope.unwrap_or_else(|| SCOPE_REMOTE_CLIENT.to_string());
        exchange_code(client, server, code_trimmed.to_string(), device_name, scope_value)?
    } else if let Some(token) = client.flag_token().or_else(|| client.env_token()).cloned() {
        let raw_server = server_url
            .filter(|s| !s.trim().is_empty())
            .or_else(|| client.explicit_server().map(ToString::to_string))
            .ok_or_else(|| Failure::usage("MissingArgument", "provide SERVER_URL (or --server) when logging in with --token"))?;
        let server = normalize_server_url(&raw_server)?;
        login_with_token(client, server, token, requested_name, requested_scope)?
    } else {
        return Err(Failure::usage(
            "MissingArgument",
            "provide --code <CODE>, --pair-url <vibevalley://pair?...>, or --token <TOKEN>",
        ));
    };

    let saved_path = auth::save(&client.home, &saved_config)?;
    let out = AuthLoginOutput {
        server: saved_config.server,
        server_name: saved_config.server_name,
        device_id: saved_config.device_id,
        device_name: saved_config.device_name,
        scope: saved_config.scope,
        auth_file: saved_path.display().to_string(),
        token_hint: saved_config.token.hint(),
    };
    client.output.show(&out, format_login);
    Ok(())
}

fn exchange_code(client: &Client, server: String, code: String, device_name: String, scope: String) -> Result<AuthConfig, Failure> {
    let target = client.for_target(server.clone(), None);
    let result = target.ask::<ops::RemotePairExchange>(&RemotePairExchangeRequest {
        code,
        device_name,
        platform: RemotePlatform::Cli,
        scope: Some(scope),
    })?;
    Ok(AuthConfig {
        server,
        token: Secret::new(result.token),
        device_id: result.device.id,
        device_name: result.device.name,
        server_name: (!result.server_name.trim().is_empty()).then_some(result.server_name),
        scope: (!result.device.scope.trim().is_empty()).then_some(result.device.scope),
    })
}

fn login_with_token(
    client: &Client,
    server: String,
    token: Secret,
    requested_name: Option<String>,
    requested_scope: Option<String>,
) -> Result<AuthConfig, Failure> {
    let target = client.for_target(server.clone(), Some(token.clone()));
    let whoami = target.ask::<ops::RemoteWhoami>(&())?;
    let device_id = whoami.device.as_ref().map(|d| d.id.clone()).unwrap_or_default();
    let device_name = requested_name
        .or_else(|| whoami.device.as_ref().map(|d| d.name.clone()).filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(default_device_name);
    let scope = whoami
        .device
        .as_ref()
        .map(|d| d.scope.clone())
        .filter(|s| !s.trim().is_empty())
        .or(requested_scope);
    let server_name = (!whoami.server_name.trim().is_empty()).then_some(whoami.server_name);
    Ok(AuthConfig {
        server,
        token,
        device_id,
        device_name,
        server_name,
        scope,
    })
}

fn run_status(client: &Client, fail_on_error: bool) -> Done {
    let auth_mode = if client.token().is_some() {
        AuthMode::RemoteBearer
    } else {
        AuthMode::LocalLoopback
    };

    let stored = (client.token_source == TokenSource::AuthFile).then(|| client.stored_auth()).flatten();
    let mut report = AuthStatusReport {
        server: client.server.clone(),
        server_source: client.server_source.as_str(),
        auth_mode,
        token_source: client.token_source.as_str(),
        device_id: stored.map(|c| c.device_id.clone()).filter(|s| !s.is_empty()),
        device_name: stored.map(|c| c.device_name.clone()).filter(|s| !s.is_empty()),
        server_name: stored.and_then(|c| c.server_name.clone()).filter(|s| !s.is_empty()),
        scope: stored.and_then(|c| c.scope.clone()).filter(|s| !s.is_empty()),
        caller: None,
        connected: false,
        authenticated: None,
        version: None,
        error: None,
    };

    let mut probe_failure: Option<Failure> = None;

    match client.probe_health() {
        Ok(health) => {
            report.connected = health.ok;
            if !health.version.is_empty() {
                report.version = Some(health.version);
            }
            if !health.ok {
                let err = Failure::new(crate::client::exit::OTHER, "Server", "server reported unhealthy");
                report.error = Some(err.text.clone());
                probe_failure = Some(err);
            } else {
                match auth_mode {
                    AuthMode::RemoteBearer => match client.ask::<ops::RemoteWhoami>(&()) {
                        Ok(whoami) => {
                            report.authenticated = Some(true);
                            if !whoami.caller.is_empty() {
                                report.caller = Some(whoami.caller);
                            }
                            if !whoami.server_name.is_empty() {
                                report.server_name = Some(whoami.server_name);
                            }
                            if !whoami.version.is_empty() {
                                report.version = Some(whoami.version);
                            }
                            if let Some(dev) = whoami.device {
                                if !dev.id.is_empty() {
                                    report.device_id = Some(dev.id);
                                }
                                if !dev.name.is_empty() {
                                    report.device_name = Some(dev.name);
                                }
                                if !dev.scope.is_empty() {
                                    report.scope = Some(dev.scope);
                                }
                            }
                        }
                        Err(err) => {
                            report.authenticated = Some(false);
                            report.error = Some(err.text.clone());
                            probe_failure = Some(err);
                        }
                    },
                    AuthMode::LocalLoopback => {
                        if let Ok(whoami) = client.ask::<ops::RemoteWhoami>(&()) {
                            if !whoami.caller.is_empty() {
                                report.caller = Some(whoami.caller);
                            }
                            if !whoami.server_name.is_empty() {
                                report.server_name = Some(whoami.server_name);
                            }
                            if !whoami.version.is_empty() {
                                report.version = Some(whoami.version);
                            }
                        }
                    }
                }
            }
        }
        Err(err) if matches!(err.status, Some(401 | 403)) => {
            report.connected = true;
            report.authenticated = Some(false);
            report.error = Some(err.text.clone());
            probe_failure = Some(err);
        }
        Err(err) => {
            report.connected = false;
            report.error = Some(err.text.clone());
            probe_failure = Some(err);
        }
    }

    client.output.show(&report, format_status);
    if fail_on_error && let Some(err) = probe_failure {
        return Err(err);
    }
    Ok(())
}

fn run_logout(client: &Client, revoke: bool) -> Done {
    if client.dry_run {
        return Err(no_dry_run("auth logout"));
    }
    let stored = auth::load(&client.home)?;
    let device_id = stored.as_ref().map(|c| c.device_id.clone()).filter(|s| !s.trim().is_empty());

    let mut revoked = false;
    let mut revoke_error: Option<String> = None;

    if revoke
        && let Some(cfg) = stored.as_ref()
        && let Some(id) = device_id.clone()
    {
        let owned_target;
        let revoke_client = if client.explicit_server().is_some() {
            client
        } else {
            owned_target = client.for_target(cfg.server.clone(), Some(cfg.token.clone()));
            &owned_target
        };
        match revoke_client.ask::<ops::RemoteDeviceRevoke>(&RemoteDeviceRevokeRequest { id }) {
            Ok(()) => revoked = true,
            Err(err) => revoke_error = Some(err.text),
        }
    }

    let removed = auth::remove(&client.home)?;
    let out = AuthLogoutOutput {
        removed,
        revoked,
        device_id,
        revoke_error,
    };
    client.output.show(&out, format_logout);
    Ok(())
}

pub fn run(client: &Client, cmd: AuthCmd) -> Done {
    match cmd.action {
        AuthAction::Login {
            server_url,
            code,
            pair_url,
            name,
            scope,
        } => run_login(client, server_url, code, pair_url, name, scope),
        AuthAction::Whoami => run_status(client, true),
        AuthAction::Status => run_status(client, false),
        AuthAction::Logout { revoke } => run_logout(client, revoke),
    }
}
