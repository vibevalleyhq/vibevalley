use std::sync::Arc;

use serde_json::{Value, json};
use tempfile::TempDir;

use crate::BoxFuture;
use crate::oar::claude::{StreamLaunch, open_sdk};
use crate::oar::process::{private_dir, probe_installation_with, secret};
use crate::oar::{Capabilities, Installation, McpServer, ModelInfo, Result, Runtime, Session, SessionOptions};

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum SdkRuntime {
    Qwen,
    Qoder,
}

impl SdkRuntime {
    fn command(self) -> &'static str {
        match self {
            Self::Qwen => "qwen",
            Self::Qoder => "qoder",
        }
    }
}

fn qwen_mcp(opts: &SessionOptions) -> Value {
    let entries: serde_json::Map<_, _> = opts
        .mcp_servers
        .iter()
        .map(|server| {
            let v = match server {
                McpServer::Http { url, headers, .. } => {
                    let mut v = json!({"httpUrl":url});
                    if !headers.is_empty() {
                        v["headers"] = server.config_entry()["headers"].clone();
                    }
                    v
                }
                McpServer::Stdio { .. } => server.config_entry(),
            };
            (server.name().to_string(), v)
        })
        .collect();
    json!(entries)
}

fn qoder_config(opts: &SessionOptions, args: &mut Vec<String>) -> Result<Option<TempDir>> {
    if opts.system_prompt.is_none() && opts.append_system_prompt.is_none() && opts.mcp_servers.is_empty() {
        return Ok(None);
    }
    let dir = private_dir("oar-qoder-")?;
    for (flag, name, prompt) in [
        ("--system-prompt-file", "system.txt", &opts.system_prompt),
        ("--append-system-prompt-file", "append.txt", &opts.append_system_prompt),
    ] {
        if let Some(text) = prompt {
            args.extend([flag.into(), secret(dir.path(), name, text.as_bytes())?]);
        }
    }
    if !opts.mcp_servers.is_empty() {
        args.extend([
            "--mcp-config".into(),
            secret(dir.path(), "mcp.json", crate::oar::mcp_config(&opts.mcp_servers).to_string().as_bytes())?,
        ]);
    }
    Ok(Some(dir))
}

impl Runtime for SdkRuntime {
    fn id(&self) -> &str {
        self.command()
    }
    fn display_name(&self) -> &str {
        match self {
            Self::Qwen => "Qwen Code",
            Self::Qoder => "Qoder CLI",
        }
    }
    fn capabilities(&self) -> Capabilities {
        crate::oar::runtime_spec(self.id()).expect("sdk runtime spec").capabilities
    }
    fn installation(&self) -> BoxFuture<'_, Installation> {
        Box::pin(async move { probe_installation_with(self.command(), None).await })
    }
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>>> {
        Box::pin(async { Ok(vec![]) })
    }

    fn open(&self, mut opts: SessionOptions) -> BoxFuture<'_, Result<Arc<dyn Session>>> {
        Box::pin(async move {
            opts.prepare(self.command())?;
            let binary = opts.binary(self.command())?;
            let mut args: Vec<String> = ["--input-format", "stream-json", "--output-format", "stream-json"]
                .into_iter()
                .map(String::from)
                .collect();
            for (flag, value) in [("--model", &opts.model), ("--resume", &opts.resume)] {
                if let Some(v) = value {
                    args.extend([flag.into(), v.clone()]);
                }
            }
            if !opts.allowed_tools.is_empty() {
                args.extend(["--allowed-tools".into(), opts.allowed_tools.join(",")]);
            }
            if !opts.additional_directories.is_empty() {
                args.extend([
                    "--include-directories".into(),
                    opts.additional_directories.iter().map(|d| d.to_string_lossy()).collect::<Vec<_>>().join(","),
                ]);
            }
            if !opts.disallowed_tools.is_empty() {
                args.extend(["--disallowed-tools".into(), opts.disallowed_tools.join(",")]);
            }
            let (initialize, secrets) = match self {
                Self::Qwen => {
                    args.push("--channel=SDK".into());
                    for (flag, value) in [("--system-prompt", &opts.system_prompt), ("--append-system-prompt", &opts.append_system_prompt)] {
                        if let Some(v) = value {
                            args.extend([flag.into(), v.clone()]);
                        }
                    }
                    let mut init = json!({"subtype":"initialize"});
                    if !opts.mcp_servers.is_empty() {
                        init["mcpServers"] = qwen_mcp(&opts);
                    }
                    (Some(init), None)
                }
                Self::Qoder => {
                    opts.env.retain(|(k, _)| k != "QODER_EXPOSE_TOKEN_USAGE");
                    opts.env.push(("QODER_EXPOSE_TOKEN_USAGE".into(), "1".into()));
                    (None, qoder_config(&opts, &mut args)?)
                }
            };
            open_sdk(
                &binary,
                &opts,
                self.capabilities(),
                StreamLaunch {
                    runtime: self.command(),
                    args,
                    initialize,
                    secrets,
                },
            )
            .await
        })
    }
}
