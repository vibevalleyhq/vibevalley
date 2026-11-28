//! Voice call orchestration (`orchestration::voice`):
//! wraps pure [`Voice`] with [`Chat`] transcript persistence and
//! [`Orchestrator`] call briefings / ASR transcript polish, implementing
//! [`LiveVoicePort`] for [`crate::gateway::api::GatewayPorts`].

use std::sync::{Arc, Weak};
use std::time::Duration;

use vibevalley_protocol::{ApiError, DEFAULT_ORCHESTRATOR, VoiceCall, VoiceGrant};

use crate::agent::Orchestrator;
use crate::channel::{Chat, Picked, Posting, Saying};
use crate::context::Context;
use crate::context::api::{BoxFuture, LiveVoiceLine, LiveVoicePort};
use crate::voice::{MossLine, MossToolRequest, Voice, prompt};

/// How long a voice call waits for the orchestrator to answer a tool call or opening briefing.
const ANSWER_WAIT: Duration = Duration::from_secs(60);

/// Application-layer voice workflow bridging [`Voice`], [`Chat`], and [`Orchestrator`].
pub struct VoiceWorkflow {
    me: Weak<Self>,
    ctx: Arc<Context>,
    voice: Arc<Voice>,
    chat: Arc<Chat>,
    orchestrator: Arc<Orchestrator>,
}

impl VoiceWorkflow {
    pub fn new(ctx: Arc<Context>, voice: Arc<Voice>, chat: Arc<Chat>, orchestrator: Arc<Orchestrator>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            ctx,
            voice,
            chat,
            orchestrator,
        })
    }

    pub fn voice(&self) -> &Arc<Voice> {
        &self.voice
    }

    pub fn grant(&self) -> Result<VoiceGrant, ApiError> {
        self.voice.grant()
    }

    pub fn start_with_about(self: &Arc<Self>, channel: &str, uid: &str, about: Option<&str>) -> Result<VoiceCall, ApiError> {
        let about = about.map(str::trim).filter(|a| !a.is_empty());
        let call = self.voice.start(channel, uid, about.is_some())?;
        if let Some(about) = about {
            self.tell(call.agent_id.clone(), prompt::on_call_line(&[], Some(about)));
        }
        Ok(call)
    }

    pub fn stop(&self, agent: &str) -> Result<(), ApiError> {
        self.voice.stop(agent)
    }

    pub fn speak(&self, text: &str) -> bool {
        self.voice.speak(text)
    }

    pub fn can_transcribe(&self) -> bool {
        self.voice.can_transcribe()
    }

    pub fn asr_line(&self) -> Result<crate::voice::MossAsrLine, ApiError> {
        self.voice.asr_line()
    }

    pub async fn transcribe_wav_async(&self, wav: Vec<u8>) -> Result<String, ApiError> {
        self.voice.transcribe_wav_async(wav).await
    }

    pub fn moss_line(self: &Arc<Self>) -> Result<MossLine, ApiError> {
        let (line, mut tool_rx) = self.voice.moss_line()?;
        let workflow = self.clone();
        self.ctx.spawn("voice.moss_tools", async move {
            while let Some(req) = tool_rx.recv().await {
                let wf = workflow.clone();
                workflow.ctx.spawn("voice.tool", async move {
                    wf.answer_moss_tool_async(req).await;
                });
            }
        });
        Ok(line)
    }

    async fn answer_moss_tool_async(&self, req: MossToolRequest) {
        let answer = self.orchestrator.brief_wait_async(req.question.clone(), ANSWER_WAIT).await.unwrap_or_default();
        req.respond(&answer);
    }

    fn tell(self: &Arc<Self>, agent: String, line: String) {
        let wf = self.clone();
        self.ctx.spawn("voice.tell", async move {
            let Some(said) = wf.orchestrator.brief_wait_async(line, ANSWER_WAIT).await else {
                return;
            };
            if !said.is_empty() {
                wf.voice.speak_on(&agent, &said);
            }
        });
    }

    pub async fn heard_async(&self, agent: &str, text: &str, picked: Option<&str>, send_key: Option<&str>) -> Result<(), ApiError> {
        self.voice.active_call_greeting(agent)?;
        self.chat
            .say_async(Saying {
                text: text.into(),
                send_key: send_key.unwrap_or("").into(),
                source: Some("voice".into()),
                picked: picked.filter(|a| !a.is_empty()).map(|a| Picked {
                    agent: Some(a.into()),
                    repo: None,
                }),
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    fn heard_background(self: &Arc<Self>, agent: &str, text: &str, send_key: Option<&str>) -> Result<(), ApiError> {
        self.voice.active_call_greeting(agent)?;
        let wf = self.clone();
        let text = text.to_string();
        let send_key = send_key.unwrap_or("").to_string();
        self.ctx.spawn("voice.heard", async move {
            if let Err(e) = wf
                .chat
                .say_async(Saying {
                    text,
                    send_key,
                    source: Some("voice".into()),
                    ..Default::default()
                })
                .await
            {
                wf.voice.warn("voice: the user's spoken words were not kept", e.message);
            }
        });
        Ok(())
    }

    pub async fn said_async(&self, agent: &str, text: &str) -> Result<(), ApiError> {
        let greeting = self.voice.active_call_greeting(agent)?;
        if text.trim() != greeting
            && let Err(e) = self
                .chat
                .post_async(Posting {
                    from: DEFAULT_ORCHESTRATOR.into(),
                    channel: self.chat.default_channel(),
                    text: text.into(),
                    run: None,
                    send_key: String::new(),
                    made: None,
                    spoken: true,
                })
                .await
        {
            self.voice.warn("voice: the orchestrator's spoken words were not kept", e.message);
        }
        Ok(())
    }

    fn said_background(self: &Arc<Self>, agent: &str, text: &str) -> Result<(), ApiError> {
        self.voice.active_call_greeting(agent)?;
        let wf = self.clone();
        let agent = agent.to_string();
        let text = text.to_string();
        self.ctx.spawn("voice.said", async move {
            let _ = wf.said_async(&agent, &text).await;
        });
        Ok(())
    }

    pub async fn polish_transcript_async(&self, raw: &str) -> Result<String, ApiError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        self.voice.ensure_running()?;
        self.orchestrator
            .polish_text_async(prompt::ASR_POLISH_SYSTEM, trimmed)
            .await
            .map_err(crate::voice::failed)
    }
}

impl LiveVoicePort for VoiceWorkflow {
    fn grant(&self) -> Result<VoiceGrant, ApiError> {
        self.voice.grant()
    }

    fn moss_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        Ok(Box::new(VoiceWorkflow::moss_line(&me)?))
    }

    fn asr_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError> {
        self.voice.asr_line().map(|line| Box::new(line) as Box<dyn LiveVoiceLine>)
    }

    fn can_transcribe(&self) -> bool {
        self.voice.can_transcribe()
    }

    fn transcribe_wav_async(&self, wav: Vec<u8>) -> BoxFuture<'static, Result<String, ApiError>> {
        let voice = self.voice.clone();
        Box::pin(async move { voice.transcribe_wav_async(wav).await })
    }

    fn polish_transcript_async(&self, raw: String) -> BoxFuture<'static, Result<String, ApiError>> {
        let me = self.me.upgrade();
        Box::pin(async move {
            let me = me.ok_or_else(Voice::stopped)?;
            me.polish_transcript_async(&raw).await
        })
    }

    fn start(&self, channel: &str, uid: &str) -> Result<VoiceCall, ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        VoiceWorkflow::start_with_about(&me, channel, uid, None)
    }

    fn heard(&self, agent_id: &str, text: &str, turn: Option<&str>) -> Result<(), ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        VoiceWorkflow::heard_background(&me, agent_id, text, turn)
    }

    fn said(&self, agent_id: &str, text: &str) -> Result<(), ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        VoiceWorkflow::said_background(&me, agent_id, text)
    }

    fn stop(&self, agent_id: &str) {
        let _ = self.voice.stop(agent_id);
    }
}
