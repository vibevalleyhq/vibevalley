//! `McpServer` handler, tool registry, client refresh, and unit tests.

use std::path::Path;

use serde_json::{Value, json};
use vibevalley_mcp::{
    BoxFuture, McpHandler, RequestContext, RpcError, ServerCapabilities, ServerInfo, SkillCatalog, ToolCallResult, ToolDef, builtin_note_skills,
    scrub_tool_result,
};
use vibevalley_protocol::home::{self, ReleaseChannel};

use super::{McpCmd, agent, issue, note, vdp};
use crate::auth::{self, Secret};
use crate::client::{Client, Failure, ServerSource};
use crate::domains::debug::{DebugTargetArgs, ResolvedEndpoint};

const SERVER_NAME: &str = "vibevalley";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpTool {
    AgentList,
    AgentRegister,
    IssueList,
    IssueGet,
    IssueCreate,
    IssueUpdate,
    IssueComment,
    AttachmentUpload,
    NoteList,
    NoteGet,
    NoteCreate,
    NoteRead,
    NoteWrite,
    NotePatch,
    NoteSuggest,
    NoteTreeMove,
    NoteLinkList,
    DocView,
    DocAppendBlock,
    BaseView,
    BaseUpsertRow,
    BaseRunAgentColumn,
    VdpDiscover,
    VdpTargets,
    VdpState,
    VdpNavigate,
    VdpResize,
    VdpTheme,
    VdpUiQuery,
    VdpUiPress,
    VdpScreenshot,
    VdpInput,
    VdpCall,
}

impl McpTool {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "vv_agent_list" => Some(Self::AgentList),
            "vv_agent_register" => Some(Self::AgentRegister),
            "vv_issue_list" => Some(Self::IssueList),
            "vv_issue_get" => Some(Self::IssueGet),
            "vv_issue_create" => Some(Self::IssueCreate),
            "vv_issue_update" => Some(Self::IssueUpdate),
            "vv_issue_comment" => Some(Self::IssueComment),
            "vv_attachment_upload" => Some(Self::AttachmentUpload),
            "vv_note_list" => Some(Self::NoteList),
            "vv_note_get" => Some(Self::NoteGet),
            "vv_note_create" => Some(Self::NoteCreate),
            "vv_note_read" => Some(Self::NoteRead),
            "vv_note_write" => Some(Self::NoteWrite),
            "vv_note_patch" => Some(Self::NotePatch),
            "vv_note_suggest" => Some(Self::NoteSuggest),
            "vv_note_tree_move" => Some(Self::NoteTreeMove),
            "vv_note_link_list" => Some(Self::NoteLinkList),
            "vv_doc_view" => Some(Self::DocView),
            "vv_doc_append_block" => Some(Self::DocAppendBlock),
            "vv_base_view" => Some(Self::BaseView),
            "vv_base_upsert_row" => Some(Self::BaseUpsertRow),
            "vv_base_run_agent_column" => Some(Self::BaseRunAgentColumn),
            "vv_vdp_discover" => Some(Self::VdpDiscover),
            "vv_vdp_targets" => Some(Self::VdpTargets),
            "vv_vdp_state" => Some(Self::VdpState),
            "vv_vdp_navigate" => Some(Self::VdpNavigate),
            "vv_vdp_resize" => Some(Self::VdpResize),
            "vv_vdp_theme" => Some(Self::VdpTheme),
            "vv_vdp_ui_query" => Some(Self::VdpUiQuery),
            "vv_vdp_ui_press" => Some(Self::VdpUiPress),
            "vv_vdp_screenshot" => Some(Self::VdpScreenshot),
            "vv_vdp_input" => Some(Self::VdpInput),
            "vv_vdp_call" => Some(Self::VdpCall),
            _ => None,
        }
    }
}

pub(super) fn tool_def(name: &str, description: &str, input_schema: Value) -> ToolDef {
    ToolDef {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema,
    }
}

fn tool_definitions() -> Vec<ToolDef> {
    let mut defs = agent::tool_definitions();
    defs.extend(issue::tool_definitions());
    defs.extend(note::tool_definitions());
    defs.extend(vdp::tool_definitions());
    defs
}

pub(super) fn non_empty_trimmed(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub(super) fn format_failure(failure: &Failure) -> String {
    let mut msg = format!("{}: {}", failure.tag, failure.text);
    if let Some(code) = failure.biz_code {
        msg.push_str(&format!(" (bizCode {code})"));
    }
    if let Some(status) = failure.status {
        msg.push_str(&format!(" (HTTP {status})"));
    }
    msg
}

pub(super) fn redact_result(mut result: ToolCallResult, secrets: &[&Secret]) -> ToolCallResult {
    let raw: Vec<&str> = secrets.iter().map(|s| s.expose()).collect();
    scrub_tool_result(&mut result, &raw);
    result
}

pub(super) struct McpServer {
    pub(super) client: tokio::sync::RwLock<Client>,
    pub(super) channel: Option<ReleaseChannel>,
    pub(super) defaults: DebugTargetArgs,
    pub(super) skills: SkillCatalog,
}

impl McpServer {
    pub(super) fn new(base: &Client, cmd: McpCmd) -> Self {
        let channel = cmd.channel.map(ReleaseChannel::from);
        let explicit_home = cmd.home.or_else(|| channel.map(home::home_for));
        let effective_home = explicit_home.clone().unwrap_or_else(|| base.home.clone());
        let client = build_client_for_home(base, &effective_home, channel);
        let mut skills = builtin_note_skills();
        if let Ok(local) = SkillCatalog::from_directory("local", &effective_home.join("skills")) {
            skills.merge(local);
        }
        let defaults = DebugTargetArgs {
            home: explicit_home,
            port: cmd.vdp_port,
            url: non_empty_trimmed(cmd.vdp_url),
        };
        Self {
            client: tokio::sync::RwLock::new(client),
            channel,
            defaults,
            skills,
        }
    }

    /// Re-checks `server.json` on the active home when no explicit `--server`/`VIBEVALLEY_SERVER`/`auth.json`
    /// is pinned, so long-lived MCP processes seamlessly follow restarted local VibeValley servers.
    pub(super) async fn refresh_client(&self) {
        let needs_refresh = {
            let client = self.client.read().await;
            if matches!(client.server_source, ServerSource::Flag | ServerSource::Env | ServerSource::AuthFile) {
                false
            } else if let Some(announced) = home::announced(&client.home) {
                let normalized = auth::normalize_server_url_lossy(&announced);
                normalized != client.server
            } else {
                false
            }
        };
        if needs_refresh {
            let mut client = self.client.write().await;
            let rebuilt = build_client_for_home(&client, &client.home, self.channel);
            *client = rebuilt;
        }
    }

    pub(super) fn known_secrets<'a>(client: &'a Client, endpoint: Option<&'a ResolvedEndpoint>) -> Vec<&'a Secret> {
        let mut out = Vec::new();
        if let Some(tok) = client.token() {
            out.push(tok);
        }
        if let Some(tok) = client.flag_token() {
            out.push(tok);
        }
        if let Some(tok) = client.env_token() {
            out.push(tok);
        }
        if let Some(ep) = endpoint
            && let Some(tok) = ep.token.as_ref()
        {
            out.push(tok);
        }
        out
    }

    pub(super) fn decode_args<T: serde::de::DeserializeOwned>(tool_name: &str, args: Value) -> Result<T, ToolCallResult> {
        serde_json::from_value(args).map_err(|err| ToolCallResult::error(format!("invalid arguments for {tool_name}: {err}")))
    }

    async fn call_tool_inner(&self, name: &str, raw_args: Value) -> ToolCallResult {
        let Some(tool) = McpTool::from_name(name) else {
            return ToolCallResult::error(format!("unknown tool: {name}"));
        };
        let args = if raw_args.is_null() { json!({}) } else { raw_args };

        match tool {
            McpTool::AgentList => self.tool_agent_list(args).await,
            McpTool::AgentRegister => self.tool_agent_register(args).await,
            McpTool::IssueList => self.tool_issue_list(args).await,
            McpTool::IssueGet => self.tool_issue_get(args).await,
            McpTool::IssueCreate => self.tool_issue_create(args).await,
            McpTool::IssueUpdate => self.tool_issue_update(args).await,
            McpTool::IssueComment => self.tool_issue_comment(args).await,
            McpTool::AttachmentUpload => self.tool_attachment_upload(args).await,
            McpTool::NoteList => self.tool_note_list(args).await,
            McpTool::NoteGet => self.tool_note_get(args).await,
            McpTool::NoteCreate => self.tool_note_create(args).await,
            McpTool::NoteRead => self.tool_note_read(args).await,
            McpTool::NoteWrite => self.tool_note_write(args).await,
            McpTool::NotePatch => self.tool_note_patch(args).await,
            McpTool::NoteSuggest => self.tool_note_suggest(args).await,
            McpTool::NoteTreeMove => self.tool_note_tree_move(args).await,
            McpTool::NoteLinkList => self.tool_note_link_list(args).await,
            McpTool::DocView => self.tool_doc_view(args).await,
            McpTool::DocAppendBlock => self.tool_doc_append_block(args).await,
            McpTool::BaseView => self.tool_base_view(args).await,
            McpTool::BaseUpsertRow => self.tool_base_upsert_row(args).await,
            McpTool::BaseRunAgentColumn => self.tool_base_run_agent_column(args).await,
            McpTool::VdpDiscover => self.tool_vdp_discover(args).await,
            McpTool::VdpTargets => self.tool_vdp_targets(args).await,
            McpTool::VdpState => self.tool_vdp_state(args).await,
            McpTool::VdpNavigate => self.tool_vdp_navigate(args).await,
            McpTool::VdpResize => self.tool_vdp_resize(args).await,
            McpTool::VdpTheme => self.tool_vdp_theme(args).await,
            McpTool::VdpUiQuery => self.tool_vdp_ui_query(args).await,
            McpTool::VdpUiPress => self.tool_vdp_ui_press(args).await,
            McpTool::VdpScreenshot => self.tool_vdp_screenshot(args).await,
            McpTool::VdpInput => self.tool_vdp_input(args).await,
            McpTool::VdpCall => self.tool_vdp_call(args).await,
        }
    }
}

impl McpHandler for McpServer {
    fn server_info(&self) -> ServerInfo {
        ServerInfo::new(SERVER_NAME, SERVER_VERSION)
    }

    fn capabilities(&self) -> ServerCapabilities {
        let mut caps = ServerCapabilities::default().with_tools();
        if !self.skills.is_empty() {
            caps = caps.with_resources().with_skills_extension(true);
        }
        caps
    }

    fn skills(&self) -> Option<&SkillCatalog> {
        Some(&self.skills)
    }

    fn list_tools<'a>(&'a self, _ctx: &'a RequestContext) -> BoxFuture<'a, Result<Vec<ToolDef>, RpcError>> {
        Box::pin(async { Ok(tool_definitions()) })
    }

    fn call_tool<'a>(&'a self, _ctx: &'a RequestContext, name: &'a str, arguments: Value) -> BoxFuture<'a, Result<ToolCallResult, RpcError>> {
        Box::pin(async move { Ok(self.call_tool_inner(name, arguments).await) })
    }
}

fn build_client_for_home(base: &Client, target_home: &Path, channel: Option<ReleaseChannel>) -> Client {
    let flag_server = (base.server_source == ServerSource::Flag).then(|| base.server.clone());
    let env_server = (base.server_source == ServerSource::Env)
        .then(|| base.server.clone())
        .or_else(|| std::env::var("VIBEVALLEY_SERVER").ok());
    let stored_auth = auth::load(target_home).ok().flatten();
    let announced = home::announced(target_home).or_else(|| channel.map(|ch| format!("http://127.0.0.1:{}", ch.default_port())));
    Client::from_parts(
        target_home.to_path_buf(),
        flag_server,
        env_server,
        base.flag_token().cloned(),
        base.env_token().cloned(),
        stored_auth,
        announced,
        false,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::super::ChannelArg;
    use super::issue::{IssueCreateArgs, IssueUpdateArgs};
    use super::note::NoteCreateArgs;
    use super::vdp::VdpOverrideArgs;
    use super::*;
    use vibevalley_mcp::{ContentBlock, error_code, serve_io};
    use vibevalley_protocol::{JsNumber, NoteType};

    fn test_client(home_dir: &Path) -> Client {
        Client::from_parts(
            home_dir.to_path_buf(),
            Some("http://127.0.0.1:9".into()),
            None,
            Some(Secret::new("vv_secret_bearer_token_123")),
            None,
            None,
            None,
            false,
            false,
        )
    }

    #[test]
    fn channel_alpha_resolves_canonical_home_and_port() {
        let base = Client::from_parts(std::path::PathBuf::from("/tmp/dev-home"), None, None, None, None, None, None, false, false);
        let server = McpServer::new(
            &base,
            McpCmd {
                channel: Some(ChannelArg::Alpha),
                home: None,
                vdp_port: None,
                vdp_url: None,
            },
        );
        let expected_home = home::home_for(ReleaseChannel::Alpha);
        let client = server.client.try_read().unwrap();
        assert_eq!(client.home, expected_home);
        assert_eq!(server.defaults.home, Some(expected_home));
        assert!(client.home.ends_with(".vibevalley-alpha"));
        assert_eq!(server.channel, Some(ReleaseChannel::Alpha));
        // Unless ~/.vibevalley-alpha has a live server.json or auth.json pointing elsewhere, fallback port is 8789.
        if auth::load(&client.home).ok().flatten().is_none() && home::announced(&client.home).is_none() {
            assert_eq!(client.server, "http://127.0.0.1:8789");
        }
    }

    #[test]
    fn vdp_target_override_precedence_respects_per_tool_home_and_port() {
        let client = test_client(Path::new("/tmp/default-home"));
        let server = McpServer::new(
            &client,
            McpCmd {
                channel: None,
                home: Some(std::path::PathBuf::from("/tmp/cli-home")),
                vdp_port: Some(9222),
                vdp_url: Some("ws://127.0.0.1:9222/devtools".into()),
            },
        );

        let default = server.resolve_vdp_target(&VdpOverrideArgs::default());
        assert_eq!(default.home, Some(std::path::PathBuf::from("/tmp/cli-home")));
        assert_eq!(default.port, Some(9222));
        assert_eq!(default.url.as_deref(), Some("ws://127.0.0.1:9222/devtools"));

        // Per-tool port overrides CLI --vdp-url while retaining default home for token lookup.
        let by_port = server.resolve_vdp_target(&VdpOverrideArgs { home: None, port: Some(9333) });
        assert_eq!(by_port.home, Some(std::path::PathBuf::from("/tmp/cli-home")));
        assert_eq!(by_port.port, Some(9333));
        assert_eq!(by_port.url, None);

        // Per-tool home overrides CLI --vdp-port and --vdp-url.
        let by_home = server.resolve_vdp_target(&VdpOverrideArgs {
            home: Some("/tmp/override-home".into()),
            port: None,
        });
        assert_eq!(by_home.home, Some(std::path::PathBuf::from("/tmp/override-home")));
        assert_eq!(by_home.port, None);
        assert_eq!(by_home.url, None);
    }

    #[test]
    fn redact_secrets_scrubs_tokens_from_tool_results() {
        let tok = Secret::new("vdp-super-secret-xyz");
        let res = redact_result(ToolCallResult::error("failed connecting with token vdp-super-secret-xyz"), &[&tok]);
        let ContentBlock::Text { text } = &res.content[0] else {
            panic!("expected text block");
        };
        assert!(!text.contains("vdp-super-secret-xyz"));
        assert!(text.contains("[redacted]"));
    }

    #[test]
    fn issue_mcp_tools_expose_and_decode_tags_parent_and_schedule_dates() {
        let defs = tool_definitions();
        for tool_name in ["vv_issue_create", "vv_issue_update"] {
            let def = defs.iter().find(|d| d.name == tool_name).expect(tool_name);
            let props = def.input_schema["properties"].as_object().expect("properties object");
            for field in ["owner", "parent", "tags", "startAt", "dueAt"] {
                assert!(props.contains_key(field), "{tool_name} missing schema property {field}");
            }
        }

        let created: IssueCreateArgs = serde_json::from_value(json!({
            "title": "Sub task",
            "owner": { "kind": "agent", "id": "arch" },
            "parent": 10,
            "tags": ["UX", "MCP"],
            "startAt": 1760000000000_i64,
            "dueAt": 1760864000000_i64
        }))
        .unwrap();
        assert_eq!(created.owner, Some(vibevalley_protocol::ActorRef::Agent { id: "arch".into() }));
        assert_eq!(created.parent.as_deref(), Some("10"));
        assert_eq!(created.tags, Some(vec!["UX".into(), "MCP".into()]));
        assert_eq!(created.start_at, Some(JsNumber::from(1_760_000_000_000_i64)));
        assert_eq!(created.due_at, Some(JsNumber::from(1_760_864_000_000_i64)));

        let updated: IssueUpdateArgs = serde_json::from_value(json!({
            "id": "#12",
            "owner": { "kind": "user", "id": "" },
            "parent": "",
            "tags": ["Bug"],
            "startAt": 0,
            "dueAt": 1760900000000_i64
        }))
        .unwrap();
        assert_eq!(updated.id, "#12");
        assert_eq!(updated.owner, Some(vibevalley_protocol::ActorRef::User { id: String::new() }));
        assert_eq!(updated.parent.as_deref(), Some(""));
        assert_eq!(updated.tags, Some(vec!["Bug".into()]));
        assert_eq!(updated.start_at, Some(JsNumber::from(0_i64)));
        assert_eq!(updated.due_at, Some(JsNumber::from(1_760_900_000_000_i64)));
    }

    #[test]
    fn note_mcp_tools_validate_all_4_types_and_guide_sep2640_skills() {
        let defs = tool_definitions();
        for expected in [
            "vv_note_list",
            "vv_note_get",
            "vv_note_create",
            "vv_note_read",
            "vv_note_write",
            "vv_note_patch",
            "vv_note_suggest",
            "vv_note_tree_move",
            "vv_note_link_list",
            "vv_doc_view",
            "vv_doc_append_block",
            "vv_base_view",
            "vv_base_upsert_row",
            "vv_base_run_agent_column",
        ] {
            assert!(defs.iter().any(|d| d.name == expected), "missing {expected}");
        }
        let create_def = defs.iter().find(|d| d.name == "vv_note_create").unwrap();
        assert!(create_def.description.contains("skill://note/<type>"));
        assert!(create_def.description.contains("skills/list"));
        assert!(create_def.description.contains("skills/get"));

        for ty in NoteType::ALL {
            let parsed: NoteCreateArgs = serde_json::from_value(json!({
                "title": "Sample",
                "noteType": ty.as_str(),
            }))
            .unwrap();
            assert_eq!(parsed.note_type, ty);
        }
        assert!(serde_json::from_value::<NoteCreateArgs>(json!({ "title": "Bad", "noteType": "nonexistent" })).is_err());
    }

    #[tokio::test]
    async fn stdio_loop_handles_initialize_discover_skills_notifications_ping_and_errors() {
        let home_dir = tempfile::tempdir().unwrap();
        let skill_dir = home_dir.path().join("skills").join("triage");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# triage: Issue triage workflow\nCheck priority.\n").unwrap();

        let client = test_client(home_dir.path());
        let server = McpServer::new(&client, McpCmd::default());

        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "not valid json\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"skills/list\",\"params\":{\"tag\":\"note\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"skills/get\",\"params\":{\"name\":\"triage\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"vv_unknown\",\"arguments\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"unknown/method\"}\n",
        );

        let mut output = Vec::new();
        serve_io(&server, tokio::io::BufReader::new(input.as_bytes()), &mut output).await.unwrap();

        let lines: Vec<Value> = String::from_utf8(output).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        // 8 responses (notifications/initialized produces none).
        assert_eq!(lines.len(), 8, "{lines:?}");
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[0]["result"]["stateless"], true);
        assert_eq!(lines[0]["result"]["serverInfo"]["name"], "vibevalley");

        assert_eq!(lines[1]["id"], 2);
        assert_eq!(lines[1]["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(lines[1]["result"]["serverInfo"]["name"], "vibevalley");

        assert_eq!(lines[2]["error"]["code"], error_code::PARSE_ERROR);

        assert_eq!(lines[3]["id"], 3);
        assert_eq!(lines[3]["result"], json!({}));

        assert_eq!(lines[4]["id"], 4);
        assert_eq!(lines[4]["result"]["skills"].as_array().unwrap().len(), 4);

        assert_eq!(lines[5]["id"], 5);
        assert_eq!(lines[5]["result"]["uri"], "skill://local/triage");
        assert!(lines[5]["result"]["content"].as_str().unwrap().contains("Check priority"));

        assert_eq!(lines[6]["id"], 6);
        assert_eq!(lines[6]["result"]["isError"], true);

        assert_eq!(lines[7]["id"], 7);
        assert_eq!(lines[7]["error"]["code"], error_code::METHOD_NOT_FOUND);
    }

    #[test]
    fn agent_mcp_tools_expose_roster_schema_and_decode_register_args() {
        let defs = tool_definitions();
        let list_def = defs.iter().find(|d| d.name == "vv_agent_list").expect("vv_agent_list");
        assert!(list_def.description.contains("O-XX"));
        let reg_def = defs.iter().find(|d| d.name == "vv_agent_register").expect("vv_agent_register");
        let props = reg_def.input_schema["properties"].as_object().expect("properties");
        for key in ["id", "name", "runtime", "duty", "avatar", "code", "tags"] {
            assert!(props.contains_key(key), "vv_agent_register missing {key}");
        }
        let decoded: super::agent::AgentRegisterArgs = serde_json::from_value(json!({
            "id": "antigravity",
            "name": "Antigravity",
            "runtime": "antigravity",
            "avatar": "avatar-fullstack",
            "code": "W-12"
        }))
        .unwrap();
        assert_eq!(decoded.id.as_deref(), Some("antigravity"));
        assert_eq!(decoded.name, "Antigravity");
        assert_eq!(decoded.runtime.as_deref(), Some("antigravity"));
        assert_eq!(decoded.avatar.as_deref(), Some("avatar-fullstack"));
        assert_eq!(decoded.code.as_deref(), Some("W-12"));
    }
}
