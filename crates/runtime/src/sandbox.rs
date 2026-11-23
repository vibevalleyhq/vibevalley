//! Ephemeral container sandbox execution layer (`SandboxProvider` & RAII `SandboxMachine`).
//!
//! Launches disposable remote machines (`vibevalley machine up --ephemeral`) inside
//! Docker or Apple Containers (`container` CLI on macOS 26+), ensuring tokens are
//! passed via child environment rather than argv, redacted in `Debug`/`Display`,
//! and containers are always terminated on `teardown()` or `Drop`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Redacted credential wrapper: serializes transparently, never exposes raw bytes in `Debug` or `Display`.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }

    /// Safe redacted suffix hint (only last 4 chars for long tokens; never reveals short secrets).
    pub fn hint(&self) -> String {
        let trimmed = self.0.trim();
        if trimmed.is_empty() {
            return "none".into();
        }
        if trimmed.chars().count() <= 8 {
            return "[redacted]".into();
        }
        let tail: String = trimmed.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        format!("…{tail}")
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_empty() {
            f.write_str("Secret(none)")
        } else {
            write!(f, "Secret({})", self.hint())
        }
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hint())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("invalid sandbox spec: {0}")]
    InvalidSpec(String),
    #[error("sandbox provider `{provider}` is unavailable: {reason}")]
    ProviderUnavailable { provider: String, reason: String },
    #[error("sandbox provider `{provider}` command `{command}` failed (exit {exit_code:?}): {stderr}")]
    CommandFailed {
        provider: String,
        command: String,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("sandbox `{0}` was already terminated")]
    AlreadyTerminated(String),
    #[error("sandbox io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Desired container specification for launching an ephemeral VibeValley execution machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSpec {
    pub image: String,
    pub machine_id: String,
    pub server_url: String,
    pub one_time_token: Secret,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpus: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<Duration>,
}

impl SandboxSpec {
    pub fn new(image: impl Into<String>, machine_id: impl Into<String>, server_url: impl Into<String>, one_time_token: impl Into<Secret>) -> Self {
        Self {
            image: image.into(),
            machine_id: machine_id.into(),
            server_url: server_url.into(),
            one_time_token: one_time_token.into(),
            repo_url: None,
            branch: None,
            runtime_id: None,
            env: BTreeMap::new(),
            memory_mb: None,
            cpus: None,
            timeout: None,
        }
    }

    pub fn validate(&self) -> Result<(), SandboxError> {
        if self.image.trim().is_empty() {
            return Err(SandboxError::InvalidSpec("image must not be empty".into()));
        }
        let machine_id = self.machine_id.trim();
        if machine_id.is_empty() {
            return Err(SandboxError::InvalidSpec("machine_id must not be empty".into()));
        }
        if !machine_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) {
            return Err(SandboxError::InvalidSpec(format!(
                "machine_id `{machine_id}` contains invalid characters (allowed: A-Z, a-z, 0-9, '-', '_', '.')"
            )));
        }
        let server_url = self.server_url.trim();
        if !(server_url.starts_with("http://") || server_url.starts_with("https://")) {
            return Err(SandboxError::InvalidSpec(format!(
                "server_url `{server_url}` must start with http:// or https://"
            )));
        }
        if self.one_time_token.is_empty() {
            return Err(SandboxError::InvalidSpec("one_time_token must not be empty".into()));
        }
        if let Some(mem) = self.memory_mb
            && mem == 0
        {
            return Err(SandboxError::InvalidSpec("memory_mb must be greater than zero".into()));
        }
        if let Some(cpus) = self.cpus
            && (!cpus.is_finite() || cpus <= 0.0)
        {
            return Err(SandboxError::InvalidSpec("cpus must be a positive finite number".into()));
        }
        if let Some(timeout) = self.timeout
            && timeout.is_zero()
        {
            return Err(SandboxError::InvalidSpec("timeout must be greater than zero".into()));
        }
        for key in self.env.keys() {
            if key.trim().is_empty() || key.contains('=') || key.contains('\0') {
                return Err(SandboxError::InvalidSpec(format!("invalid env key `{key}`")));
            }
        }
        Ok(())
    }
}

/// Live handle to a spawned container sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxHandle {
    pub sandbox_id: String,
    pub machine_id: String,
    pub container_id: String,
    pub provider: String,
}

/// Materialized subprocess invocation with secret-bearing environment entries kept out of argv.
#[derive(Clone, PartialEq, Eq)]
pub struct SandboxCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, Secret>,
}

impl SandboxCommand {
    pub fn to_std_command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args).stdin(Stdio::null());
        for (k, v) in &self.env {
            cmd.env(k, v.expose());
        }
        cmd
    }
}

impl fmt::Debug for SandboxCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SandboxCommand")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &self.env)
            .finish()
    }
}

/// Container runtime backend capable of launching and tearing down ephemeral sandbox machines.
pub trait SandboxProvider: Send + Sync {
    fn name(&self) -> &str;
    fn is_available(&self) -> bool;
    fn spawn(&self, spec: &SandboxSpec) -> Result<SandboxHandle, SandboxError>;
    fn terminate(&self, handle: &SandboxHandle) -> Result<(), SandboxError>;
    fn is_running(&self, handle: &SandboxHandle) -> Result<bool, SandboxError>;
}

fn make_sandbox_id(machine_id: &str) -> String {
    let prefix: String = machine_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' })
        .take(24)
        .collect();
    let trimmed = prefix.trim_matches('-');
    let short = &Uuid::new_v4().simple().to_string()[..12];
    if trimmed.is_empty() {
        format!("vv-sbx-{short}")
    } else {
        format!("vv-sbx-{trimmed}-{short}")
    }
}

fn sanitize_stderr(stderr: &str, token: Option<&Secret>) -> String {
    let trimmed = stderr.trim();
    match token.filter(|t| !t.is_empty()) {
        Some(secret) => trimmed.replace(secret.expose(), "[redacted]"),
        None => trimmed.to_string(),
    }
}

fn append_common_env_flags(args: &mut Vec<String>, spec: &SandboxSpec) {
    for (k, v) in &spec.env {
        if matches!(
            k.as_str(),
            "VIBEVALLEY_SERVER" | "VIBEVALLEY_TOKEN" | "VIBEVALLEY_SANDBOX" | "VIBEVALLEY_REPO_URL" | "VIBEVALLEY_BRANCH" | "VIBEVALLEY_SANDBOX_TIMEOUT_SECS"
        ) {
            continue;
        }
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    args.push("-e".into());
    args.push("VIBEVALLEY_SANDBOX=1".into());
    args.push("-e".into());
    args.push(format!("VIBEVALLEY_SERVER={}", spec.server_url.trim()));
    // Inherit VIBEVALLEY_TOKEN from the child process environment so raw tokens never appear in argv / `ps`.
    args.push("-e".into());
    args.push("VIBEVALLEY_TOKEN".into());
    if let Some(repo_url) = spec.repo_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("-e".into());
        args.push(format!("VIBEVALLEY_REPO_URL={repo_url}"));
    }
    if let Some(branch) = spec.branch.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("-e".into());
        args.push(format!("VIBEVALLEY_BRANCH={branch}"));
    }
    if let Some(timeout) = spec.timeout {
        args.push("-e".into());
        args.push(format!("VIBEVALLEY_SANDBOX_TIMEOUT_SECS={}", timeout.as_secs().max(1)));
    }
}

fn append_machine_up_args(args: &mut Vec<String>, spec: &SandboxSpec) {
    args.push(spec.image.trim().to_string());
    args.push("vibevalley".into());
    args.push("machine".into());
    args.push("up".into());
    args.push("--ephemeral".into());
    args.push("--machine-id".into());
    args.push(spec.machine_id.trim().to_string());
    args.push("--server".into());
    args.push(spec.server_url.trim().to_string());
    if let Some(runtime_id) = spec.runtime_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--runtime".into());
        args.push(runtime_id.to_string());
    }
}

/// Docker Engine container provider (`docker run -d --rm ...`).
#[derive(Debug, Clone)]
pub struct DockerSandboxProvider {
    binary: PathBuf,
}

impl DockerSandboxProvider {
    pub fn new() -> Self {
        Self {
            binary: PathBuf::from("docker"),
        }
    }

    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self { binary: binary.into() }
    }

    pub fn build_run_args(spec: &SandboxSpec, sandbox_id: &str) -> Result<Vec<String>, SandboxError> {
        spec.validate()?;
        let mut args = vec![
            "run".into(),
            "-d".into(),
            "--rm".into(),
            "--name".into(),
            sandbox_id.to_string(),
            "--label".into(),
            format!("vibevalley.sandbox={sandbox_id}"),
            "--label".into(),
            format!("vibevalley.machine={}", spec.machine_id.trim()),
        ];
        if let Some(mem) = spec.memory_mb {
            args.push("--memory".into());
            args.push(format!("{mem}m"));
        }
        if let Some(cpus) = spec.cpus {
            args.push("--cpus".into());
            args.push(format!("{cpus}"));
        }
        append_common_env_flags(&mut args, spec);
        append_machine_up_args(&mut args, spec);
        Ok(args)
    }

    pub fn build_run_command(&self, spec: &SandboxSpec, sandbox_id: &str) -> Result<SandboxCommand, SandboxError> {
        let args = Self::build_run_args(spec, sandbox_id)?;
        let mut env = BTreeMap::new();
        env.insert("VIBEVALLEY_TOKEN".into(), spec.one_time_token.clone());
        Ok(SandboxCommand {
            program: self.binary.clone(),
            args,
            env,
        })
    }

    pub fn build_terminate_args(container_id: &str) -> Vec<String> {
        vec!["rm".into(), "-f".into(), container_id.to_string()]
    }

    pub fn build_inspect_args(container_id: &str) -> Vec<String> {
        vec!["inspect".into(), "-f".into(), "{{.State.Running}}".into(), container_id.to_string()]
    }
}

impl Default for DockerSandboxProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxProvider for DockerSandboxProvider {
    fn name(&self) -> &str {
        "docker"
    }

    fn is_available(&self) -> bool {
        Command::new(&self.binary)
            .args(["info", "--format", "{{.ServerVersion}}"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    fn spawn(&self, spec: &SandboxSpec) -> Result<SandboxHandle, SandboxError> {
        let sandbox_id = make_sandbox_id(&spec.machine_id);
        let cmd = self.build_run_command(spec, &sandbox_id)?;
        let output = cmd.to_std_command().output()?;
        if !output.status.success() {
            return Err(SandboxError::CommandFailed {
                provider: self.name().into(),
                command: "docker run".into(),
                exit_code: output.status.code(),
                stderr: sanitize_stderr(&String::from_utf8_lossy(&output.stderr), Some(&spec.one_time_token)),
            });
        }
        let container_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let container_id = if container_id.is_empty() { sandbox_id.clone() } else { container_id };
        Ok(SandboxHandle {
            sandbox_id,
            machine_id: spec.machine_id.trim().to_string(),
            container_id,
            provider: self.name().into(),
        })
    }

    fn terminate(&self, handle: &SandboxHandle) -> Result<(), SandboxError> {
        let args = Self::build_terminate_args(&handle.container_id);
        let output = Command::new(&self.binary).args(&args).stdin(Stdio::null()).output()?;
        if !output.status.success() {
            let stderr = sanitize_stderr(&String::from_utf8_lossy(&output.stderr), None);
            if stderr.contains("No such container") {
                return Ok(());
            }
            return Err(SandboxError::CommandFailed {
                provider: self.name().into(),
                command: "docker rm -f".into(),
                exit_code: output.status.code(),
                stderr,
            });
        }
        Ok(())
    }

    fn is_running(&self, handle: &SandboxHandle) -> Result<bool, SandboxError> {
        let args = Self::build_inspect_args(&handle.container_id);
        let output = Command::new(&self.binary).args(&args).stdin(Stdio::null()).output()?;
        if !output.status.success() {
            return Ok(false);
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim() == "true")
    }
}

/// Apple Containers provider (`container run --rm ...` on macOS 26+).
#[derive(Debug, Clone)]
pub struct AppleContainerSandboxProvider {
    binary: PathBuf,
}

impl AppleContainerSandboxProvider {
    pub fn new() -> Self {
        Self {
            binary: PathBuf::from("container"),
        }
    }

    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self { binary: binary.into() }
    }

    pub fn build_run_args(spec: &SandboxSpec, sandbox_id: &str) -> Result<Vec<String>, SandboxError> {
        spec.validate()?;
        let mut args = vec!["run".into(), "--detach".into(), "--rm".into(), "--name".into(), sandbox_id.to_string()];
        if let Some(mem) = spec.memory_mb {
            args.push("--memory".into());
            args.push(format!("{mem}M"));
        }
        if let Some(cpus) = spec.cpus {
            args.push("--cpus".into());
            args.push(format!("{cpus}"));
        }
        append_common_env_flags(&mut args, spec);
        append_machine_up_args(&mut args, spec);
        Ok(args)
    }

    pub fn build_run_command(&self, spec: &SandboxSpec, sandbox_id: &str) -> Result<SandboxCommand, SandboxError> {
        let args = Self::build_run_args(spec, sandbox_id)?;
        let mut env = BTreeMap::new();
        env.insert("VIBEVALLEY_TOKEN".into(), spec.one_time_token.clone());
        Ok(SandboxCommand {
            program: self.binary.clone(),
            args,
            env,
        })
    }

    pub fn build_terminate_args(container_id: &str) -> Vec<String> {
        vec!["delete".into(), "--force".into(), container_id.to_string()]
    }

    pub fn build_inspect_args(container_id: &str) -> Vec<String> {
        vec!["inspect".into(), container_id.to_string()]
    }
}

impl Default for AppleContainerSandboxProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxProvider for AppleContainerSandboxProvider {
    fn name(&self) -> &str {
        "apple-container"
    }

    fn is_available(&self) -> bool {
        if !cfg!(target_os = "macos") {
            return false;
        }
        Command::new(&self.binary)
            .args(["--version"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    fn spawn(&self, spec: &SandboxSpec) -> Result<SandboxHandle, SandboxError> {
        let sandbox_id = make_sandbox_id(&spec.machine_id);
        let cmd = self.build_run_command(spec, &sandbox_id)?;
        let output = cmd.to_std_command().output()?;
        if !output.status.success() {
            return Err(SandboxError::CommandFailed {
                provider: self.name().into(),
                command: "container run".into(),
                exit_code: output.status.code(),
                stderr: sanitize_stderr(&String::from_utf8_lossy(&output.stderr), Some(&spec.one_time_token)),
            });
        }
        let container_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let container_id = if container_id.is_empty() { sandbox_id.clone() } else { container_id };
        Ok(SandboxHandle {
            sandbox_id,
            machine_id: spec.machine_id.trim().to_string(),
            container_id,
            provider: self.name().into(),
        })
    }

    fn terminate(&self, handle: &SandboxHandle) -> Result<(), SandboxError> {
        let args = Self::build_terminate_args(&handle.container_id);
        let output = Command::new(&self.binary).args(&args).stdin(Stdio::null()).output()?;
        if !output.status.success() {
            let stderr = sanitize_stderr(&String::from_utf8_lossy(&output.stderr), None);
            if stderr.to_ascii_lowercase().contains("not found") {
                return Ok(());
            }
            return Err(SandboxError::CommandFailed {
                provider: self.name().into(),
                command: "container delete --force".into(),
                exit_code: output.status.code(),
                stderr,
            });
        }
        Ok(())
    }

    fn is_running(&self, handle: &SandboxHandle) -> Result<bool, SandboxError> {
        let args = Self::build_inspect_args(&handle.container_id);
        let output = Command::new(&self.binary).args(&args).stdin(Stdio::null()).output()?;
        if !output.status.success() {
            return Ok(false);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&stdout) else {
            return Ok(false);
        };
        let entry = value.as_array().and_then(|arr| arr.first()).unwrap_or(&value);
        Ok(entry
            .get("status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|status| status.eq_ignore_ascii_case("running")))
    }
}

#[derive(Default)]
struct MockState {
    available: bool,
    next_id: u64,
    spawned: Vec<(SandboxSpec, SandboxHandle)>,
    running: BTreeSet<String>,
    terminated: Vec<String>,
    fail_spawn: Option<String>,
    fail_terminate: Option<String>,
}

/// Deterministic in-memory `SandboxProvider` for offline unit and integration tests.
pub struct MockSandboxProvider {
    state: Mutex<MockState>,
}

impl MockSandboxProvider {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(MockState {
                available: true,
                ..Default::default()
            }),
        }
    }

    pub fn set_available(&self, available: bool) {
        self.state.lock().available = available;
    }

    pub fn set_fail_spawn(&self, error: Option<String>) {
        self.state.lock().fail_spawn = error;
    }

    pub fn set_fail_terminate(&self, error: Option<String>) {
        self.state.lock().fail_terminate = error;
    }

    pub fn spawned(&self) -> Vec<(SandboxSpec, SandboxHandle)> {
        self.state.lock().spawned.clone()
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.state.lock().running.iter().cloned().collect()
    }

    pub fn terminated_ids(&self) -> Vec<String> {
        self.state.lock().terminated.clone()
    }
}

impl Default for MockSandboxProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for MockSandboxProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let state = self.state.lock();
        f.debug_struct("MockSandboxProvider")
            .field("available", &state.available)
            .field("spawned_count", &state.spawned.len())
            .field("running", &state.running)
            .field("terminated", &state.terminated)
            .finish()
    }
}

impl SandboxProvider for MockSandboxProvider {
    fn name(&self) -> &str {
        "mock"
    }

    fn is_available(&self) -> bool {
        self.state.lock().available
    }

    fn spawn(&self, spec: &SandboxSpec) -> Result<SandboxHandle, SandboxError> {
        spec.validate()?;
        let mut state = self.state.lock();
        if !state.available {
            return Err(SandboxError::ProviderUnavailable {
                provider: self.name().into(),
                reason: "mock provider marked unavailable".into(),
            });
        }
        if let Some(reason) = state.fail_spawn.take() {
            return Err(SandboxError::CommandFailed {
                provider: self.name().into(),
                command: "mock spawn".into(),
                exit_code: Some(1),
                stderr: reason,
            });
        }
        state.next_id += 1;
        let seq = state.next_id;
        let sandbox_id = format!("mock-sbx-{seq}");
        let container_id = format!("mock-ctr-{seq}");
        let handle = SandboxHandle {
            sandbox_id,
            machine_id: spec.machine_id.trim().to_string(),
            container_id: container_id.clone(),
            provider: self.name().into(),
        };
        state.running.insert(container_id);
        state.spawned.push((spec.clone(), handle.clone()));
        Ok(handle)
    }

    fn terminate(&self, handle: &SandboxHandle) -> Result<(), SandboxError> {
        let mut state = self.state.lock();
        if let Some(reason) = state.fail_terminate.take() {
            return Err(SandboxError::CommandFailed {
                provider: self.name().into(),
                command: "mock terminate".into(),
                exit_code: Some(1),
                stderr: reason,
            });
        }
        state.running.remove(&handle.container_id);
        state.terminated.push(handle.container_id.clone());
        Ok(())
    }

    fn is_running(&self, handle: &SandboxHandle) -> Result<bool, SandboxError> {
        Ok(self.state.lock().running.contains(&handle.container_id))
    }
}

/// Ephemeral RAII sandbox lifecycle guard: guarantees `provider.terminate(&handle)` runs
/// at most once on explicit `teardown()` or automatically on `Drop`.
pub struct SandboxMachine {
    provider: Arc<dyn SandboxProvider>,
    handle: SandboxHandle,
    terminated: AtomicBool,
}

impl SandboxMachine {
    pub fn launch(provider: Arc<dyn SandboxProvider>, spec: &SandboxSpec) -> Result<Self, SandboxError> {
        let handle = provider.spawn(spec)?;
        Ok(Self::from_handle(provider, handle))
    }

    pub fn from_handle(provider: Arc<dyn SandboxProvider>, handle: SandboxHandle) -> Self {
        Self {
            provider,
            handle,
            terminated: AtomicBool::new(false),
        }
    }

    pub fn handle(&self) -> &SandboxHandle {
        &self.handle
    }

    pub fn sandbox_id(&self) -> &str {
        &self.handle.sandbox_id
    }

    pub fn machine_id(&self) -> &str {
        &self.handle.machine_id
    }

    pub fn is_terminated(&self) -> bool {
        self.terminated.load(Ordering::Acquire)
    }

    pub fn is_running(&self) -> Result<bool, SandboxError> {
        if self.is_terminated() {
            return Ok(false);
        }
        self.provider.is_running(&self.handle)
    }

    /// Idempotently terminates the container. If the provider fails, leaves the handle armed
    /// so a subsequent `teardown()` or `Drop` retries termination.
    pub fn teardown(&self) -> Result<(), SandboxError> {
        if self.terminated.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Ok(());
        }
        if let Err(err) = self.provider.terminate(&self.handle) {
            self.terminated.store(false, Ordering::Release);
            return Err(err);
        }
        Ok(())
    }
}

impl Drop for SandboxMachine {
    fn drop(&mut self) {
        let _ = self.teardown();
    }
}

impl fmt::Debug for SandboxMachine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SandboxMachine")
            .field("provider", &self.provider.name())
            .field("handle", &self.handle)
            .field("terminated", &self.is_terminated())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_spec() -> SandboxSpec {
        let mut spec = SandboxSpec::new(
            "ghcr.io/vibevalley/sandbox:latest",
            "sbx-ci-42",
            "https://mac.tailnet.ts.net:8890",
            "vv_dev_one_time_secret_token_9876543210",
        );
        spec.repo_url = Some("https://github.com/acme/demo.git".into());
        spec.branch = Some("feat/sandbox".into());
        spec.runtime_id = Some("claude".into());
        spec.memory_mb = Some(4096);
        spec.cpus = Some(2.5);
        spec.timeout = Some(Duration::from_secs(900));
        spec.env.insert("RUST_LOG".into(), "info".into());
        // Attempting to override VIBEVALLEY_TOKEN in plain env must be ignored in favor of one_time_token.
        spec.env.insert("VIBEVALLEY_TOKEN".into(), "should-not-win".into());
        spec
    }

    #[test]
    fn secret_and_sandbox_types_never_leak_token_in_debug_or_display() {
        let raw = "vv_dev_one_time_secret_token_9876543210";
        let spec = sample_spec();
        let spec_debug = format!("{spec:?}");
        assert!(!spec_debug.contains(raw), "SandboxSpec Debug leaked token: {spec_debug}");
        assert!(spec_debug.contains("3210"), "expected redacted tail hint: {spec_debug}");

        let short = Secret::new("short123");
        assert_eq!(format!("{short}"), "[redacted]");
        assert!(!format!("{short:?}").contains("short123"));

        let docker = DockerSandboxProvider::new();
        let cmd = docker.build_run_command(&spec, "vv-sbx-test-1").unwrap();
        let cmd_debug = format!("{cmd:?}");
        assert!(!cmd_debug.contains(raw), "SandboxCommand Debug leaked token: {cmd_debug}");
        assert!(!cmd.args.iter().any(|a| a.contains(raw)), "raw token leaked into docker argv: {:?}", cmd.args);
        assert_eq!(cmd.env.get("VIBEVALLEY_TOKEN").map(Secret::expose), Some(raw));

        let mock = Arc::new(MockSandboxProvider::new());
        let machine = SandboxMachine::launch(mock, &spec).unwrap();
        let machine_debug = format!("{machine:?}");
        assert!(!machine_debug.contains(raw), "SandboxMachine Debug leaked token: {machine_debug}");
    }

    #[test]
    fn docker_command_builder_generates_expected_flags_and_machine_up_args() {
        let spec = sample_spec();
        let docker = DockerSandboxProvider::with_binary("/usr/local/bin/docker");
        let cmd = docker.build_run_command(&spec, "vv-sbx-42").unwrap();

        assert_eq!(cmd.program, PathBuf::from("/usr/local/bin/docker"));
        assert_eq!(&cmd.args[..5], &["run", "-d", "--rm", "--name", "vv-sbx-42"]);
        assert!(cmd.args.windows(2).any(|w| w == ["--label", "vibevalley.sandbox=vv-sbx-42"]));
        assert!(cmd.args.windows(2).any(|w| w == ["--label", "vibevalley.machine=sbx-ci-42"]));
        assert!(cmd.args.windows(2).any(|w| w == ["--memory", "4096m"]));
        assert!(cmd.args.windows(2).any(|w| w == ["--cpus", "2.5"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "RUST_LOG=info"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_SANDBOX=1"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_SERVER=https://mac.tailnet.ts.net:8890"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_TOKEN"]));
        assert!(
            !cmd.args.iter().any(|a| a.contains("should-not-win")),
            "reserved env key must not override one_time_token"
        );
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_REPO_URL=https://github.com/acme/demo.git"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_BRANCH=feat/sandbox"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_SANDBOX_TIMEOUT_SECS=900"]));

        let image_pos = cmd.args.iter().position(|a| a == "ghcr.io/vibevalley/sandbox:latest").unwrap();
        assert_eq!(
            &cmd.args[image_pos + 1..],
            &[
                "vibevalley",
                "machine",
                "up",
                "--ephemeral",
                "--machine-id",
                "sbx-ci-42",
                "--server",
                "https://mac.tailnet.ts.net:8890",
                "--runtime",
                "claude",
            ]
        );
        assert_eq!(DockerSandboxProvider::build_terminate_args("ctr-1"), vec!["rm", "-f", "ctr-1"]);
        assert_eq!(
            DockerSandboxProvider::build_inspect_args("ctr-1"),
            vec!["inspect", "-f", "{{.State.Running}}", "ctr-1"]
        );
    }

    #[test]
    fn apple_container_command_builder_generates_expected_flags_and_machine_up_args() {
        let spec = sample_spec();
        let apple = AppleContainerSandboxProvider::with_binary("/usr/local/bin/container");
        let cmd = apple.build_run_command(&spec, "vv-sbx-mac-1").unwrap();

        assert_eq!(cmd.program, PathBuf::from("/usr/local/bin/container"));
        assert_eq!(&cmd.args[..5], &["run", "--detach", "--rm", "--name", "vv-sbx-mac-1"]);
        assert!(cmd.args.windows(2).any(|w| w == ["--memory", "4096M"]));
        assert!(cmd.args.windows(2).any(|w| w == ["--cpus", "2.5"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_SERVER=https://mac.tailnet.ts.net:8890"]));
        assert!(cmd.args.windows(2).any(|w| w == ["-e", "VIBEVALLEY_TOKEN"]));
        assert!(!cmd.args.iter().any(|a| a.contains(spec.one_time_token.expose())));
        assert_eq!(cmd.env.get("VIBEVALLEY_TOKEN").map(Secret::expose), Some(spec.one_time_token.expose()));

        let image_pos = cmd.args.iter().position(|a| a == "ghcr.io/vibevalley/sandbox:latest").unwrap();
        assert_eq!(
            &cmd.args[image_pos + 1..],
            &[
                "vibevalley",
                "machine",
                "up",
                "--ephemeral",
                "--machine-id",
                "sbx-ci-42",
                "--server",
                "https://mac.tailnet.ts.net:8890",
                "--runtime",
                "claude",
            ]
        );
        assert_eq!(AppleContainerSandboxProvider::build_terminate_args("ctr-2"), vec!["delete", "--force", "ctr-2"]);
        assert_eq!(AppleContainerSandboxProvider::build_inspect_args("ctr-2"), vec!["inspect", "ctr-2"]);
    }

    #[test]
    fn sandbox_spec_validation_rejects_invalid_inputs() {
        let valid = sample_spec();
        assert!(valid.validate().is_ok());

        let mut bad_image = valid.clone();
        bad_image.image = "  ".into();
        assert!(matches!(bad_image.validate(), Err(SandboxError::InvalidSpec(_))));

        let mut bad_id = valid.clone();
        bad_id.machine_id = "../escape".into();
        assert!(matches!(bad_id.validate(), Err(SandboxError::InvalidSpec(_))));

        let mut bad_url = valid.clone();
        bad_url.server_url = "ws://127.0.0.1:8790".into();
        assert!(matches!(bad_url.validate(), Err(SandboxError::InvalidSpec(_))));

        let mut empty_token = valid.clone();
        empty_token.one_time_token = Secret::new("   ");
        assert!(matches!(empty_token.validate(), Err(SandboxError::InvalidSpec(_))));

        let mut zero_mem = valid.clone();
        zero_mem.memory_mb = Some(0);
        assert!(matches!(zero_mem.validate(), Err(SandboxError::InvalidSpec(_))));

        let mut bad_cpus = valid.clone();
        bad_cpus.cpus = Some(f64::NAN);
        assert!(matches!(bad_cpus.validate(), Err(SandboxError::InvalidSpec(_))));

        let mut zero_timeout = valid;
        zero_timeout.timeout = Some(Duration::ZERO);
        assert!(matches!(zero_timeout.validate(), Err(SandboxError::InvalidSpec(_))));
    }

    #[test]
    fn mock_provider_and_sandbox_machine_enforce_raii_drop_and_idempotent_teardown() {
        let provider = Arc::new(MockSandboxProvider::new());
        assert!(provider.is_available());
        let spec = sample_spec();

        // 1. Implicit RAII Drop tears down the container cleanly with zero leaks.
        let container_id_1 = {
            let machine = SandboxMachine::launch(provider.clone(), &spec).unwrap();
            assert_eq!(machine.machine_id(), "sbx-ci-42");
            assert!(!machine.is_terminated());
            assert!(machine.is_running().unwrap());
            assert_eq!(provider.running_ids(), vec!["mock-ctr-1"]);
            machine.handle().container_id.clone()
        };
        assert_eq!(container_id_1, "mock-ctr-1");
        assert!(provider.running_ids().is_empty());
        assert_eq!(provider.terminated_ids(), vec!["mock-ctr-1"]);

        // 2. Explicit teardown is idempotent and subsequent Drop does NOT double-terminate.
        {
            let machine = SandboxMachine::launch(provider.clone(), &spec).unwrap();
            assert!(machine.is_running().unwrap());
            machine.teardown().unwrap();
            assert!(machine.is_terminated());
            assert!(!machine.is_running().unwrap());
            machine.teardown().unwrap();
        }
        assert_eq!(provider.terminated_ids(), vec!["mock-ctr-1", "mock-ctr-2"]);

        // 3. Failed explicit teardown keeps guard armed so Drop retries termination.
        provider.set_fail_terminate(Some("transient busy".into()));
        {
            let machine = SandboxMachine::launch(provider.clone(), &spec).unwrap();
            let err = machine.teardown().unwrap_err();
            assert!(matches!(err, SandboxError::CommandFailed { .. }));
            assert!(!machine.is_terminated());
        }
        assert!(provider.running_ids().is_empty());
        assert_eq!(provider.terminated_ids(), vec!["mock-ctr-1", "mock-ctr-2", "mock-ctr-3"]);

        // 4. Unavailable provider refuses spawn cleanly.
        provider.set_available(false);
        assert!(matches!(SandboxMachine::launch(provider, &spec), Err(SandboxError::ProviderUnavailable { .. })));
    }
}
