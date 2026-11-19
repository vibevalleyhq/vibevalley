//! Several voices, a designed voice, a clone, a transcript and understanding on the job machine, against MOSS
//! answered offline. One network is kept across restarts, so the vendor remembers what it was asked.
use serde_json::{Value, json};
use std::{
    io::Cursor,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use vibevalley_protocol::Caller;
use vibevalley_server::{
    Server,
    modules::media::vendor::{Fetch, Request},
};

struct Network {
    vendor: Arc<dyn Fetch>,
    download: Arc<dyn Fetch>,
    /// Every vendor request, as `METHOD /path`.
    calls: Arc<Mutex<Vec<String>>>,
}
impl Network {
    fn new() -> Network {
        let (vendor, download) = vibevalley_server::offline::network();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let recorded: Arc<dyn Fetch> = Arc::new(move |r: Request| {
            let path = r.url.trim_start_matches("https://api.mosi.cn/v1").to_string();
            seen.lock().unwrap().push(format!("{} {path}", r.method));
            vendor.fetch(r)
        });
        Network {
            vendor: recorded,
            download,
            calls,
        }
    }
    fn count(&self, call: &str) -> usize {
        self.calls.lock().unwrap().iter().filter(|c| c.starts_with(call)).count()
    }
    fn until(&self, call: &str, times: usize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.count(call) < times {
            assert!(
                Instant::now() < deadline,
                "the vendor was not asked {call} {times} times: {:?}",
                self.calls.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
fn start(dir: &std::path::Path, network: &Network) -> vibevalley_server::Started {
    let mut registry = vibevalley_oar::Registry::new();
    registry.register(Arc::new(vibevalley_oar::scripted::ScriptedRuntime::demo()));
    vibevalley_server::start(vibevalley_server::ServerConfig {
        registry: Some(Arc::new(registry)),
        media_network: Some((network.vendor.clone(), network.download.clone())),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        watch_pkm: false,
        ..vibevalley_server::ServerConfig::under(dir)
    })
    .unwrap()
}
fn ok(s: &vibevalley_server::Started, op: &str, p: Value) -> Value {
    let e = s.hub.call(op, p);
    assert_eq!(e.biz_code, 0, "{op}: {}", e.message);
    e.data.unwrap_or(Value::Null)
}
fn refused(s: &vibevalley_server::Started, op: &str, p: Value) {
    assert_ne!(s.hub.call(op, p).biz_code, 0, "{op} was not refused");
}
/// Binds every media use to one account with `key`; the revision requests then name.
fn bind(s: &vibevalley_server::Started, key: &str) -> i64 {
    let at = ok(s, "provider.get", Value::Null)["revision"].as_i64().unwrap();
    let to = |model: &str| json!({"connection":"moss","model":model});
    let status = ok(
        s,
        "provider.update",
        json!({
            "revision": at,
            "connections": [{"id":"moss","name":"MOSS","adapter":"moss","enabled":true,"key":key}],
            "speech": to("moss-tts-1.0-pro"),
            "speakers": to("moss-ttsd-1.0"),
            "voiceDesign": to("moss-voice-generator-1.0"),
            "transcription": to("moss-transcribe-diarize-pro"),
            "understanding": to("moss-vl-1.0"),
            "dictation": null, "image": null, "live": null, "vision": null,
        }),
    );
    status["revision"].as_i64().unwrap()
}
fn input(s: &vibevalley_server::Started, kind: &str, mime: &str, name: &str, bytes: Vec<u8>) -> String {
    let made = ok(s, "media.input.create", json!({"kind":kind,"mime":mime,"name":name,"size":bytes.len()}));
    let id = made["id"].as_str().unwrap().to_string();
    s.media_inputs.upload(&id, Cursor::new(bytes)).unwrap();
    id
}
fn sample(s: &vibevalley_server::Started) -> String {
    input(s, "audio", "audio/wav", "sample.wav", vibevalley_server::offline::wav(2880))
}
fn picture(s: &vibevalley_server::Started) -> String {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(24, 0);
    input(s, "image", "image/png", "cat.png", png)
}
fn deletable(s: &vibevalley_server::Started, input: &str) -> bool {
    ok(s, "media.input.get", json!({"id":input}))["canDelete"] == true
}
fn until(s: &vibevalley_server::Started, id: &str, what: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let j = ok(s, "media.job.get", json!({"id":id}));
        if done(&j) {
            return j;
        }
        assert!(Instant::now() < deadline, "job did not reach {what}: {j}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn wait(s: &vibevalley_server::Started, id: &str, phase: &str) -> Value {
    until(s, id, phase, |j| j["phase"] == phase)
}
fn dialogue(id: &str, revision: i64, text: &str) -> Value {
    json!({
        "id": id, "connection": "moss", "revision": revision, "format": "wav",
        "speakers": [{"id":"a","voice":"voice-one"},{"id":"b","voice":"voice-two"}],
        "segments": [{"speaker":"a","text":text},{"speaker":"b","text":"Hello back."}],
    })
}
fn design(id: &str, revision: i64, text: &str) -> Value {
    json!({"id":id,"connection":"moss","revision":revision,"format":"wav","text":text,"instruction":"A calm narrator."})
}
fn transcription(id: &str, revision: i64, input: &str, streaming: bool) -> Value {
    json!({"id":id,"connection":"moss","revision":revision,"input":input,"allowUpload":true,"diarize":true,"streaming":streaming})
}
fn understanding(id: &str, revision: i64, input: &str, prompt: &str) -> Value {
    json!({"id":id,"connection":"moss","revision":revision,"inputs":[input],"prompt":prompt,"allowUpload":true,"maxOutputTokens":512})
}
type Tools = (Vec<Box<dyn vibevalley_agent::Tool>>, Arc<Mutex<vibevalley_server::modules::tool::Route>>);
fn tools(s: &vibevalley_server::Started, channel: &str) -> Tools {
    use vibevalley_server::modules::tool::{Route, held};
    let route = Arc::new(Mutex::new(Route {
        agent: "orchestrator".into(),
        channel: channel.into(),
        ..Route::default()
    }));
    (held(&s.farm, &route), route)
}

#[test]
fn a_dialogue_and_a_designed_voice_are_followed_kept_and_released() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-audio");
    let made = ok(&s, "media.dialogue.create", dialogue("talk", revision, "Hello there."));
    assert_eq!(
        (&made["kind"], &made["prompt"]),
        (&json!("speakers"), &json!("a: Hello there.\nb: Hello back."))
    );
    let ready = wait(&s, "talk", "ready");
    assert_eq!((&ready["format"], &ready["contentType"]), (&json!("wav"), &json!("audio/wav")));
    assert_eq!(ready["metadata"]["sampleRate"].as_f64(), Some(24000.0));
    assert!(s.attachments.file(ready["attachment"]["id"].as_str().unwrap()).is_ok());
    // The same request is the same job; another under its id is refused; nothing is asked of the vendor twice.
    assert_eq!(ok(&s, "media.dialogue.create", dialogue("talk", revision, "Hello there."))["phase"], "ready");
    refused(&s, "media.dialogue.create", dialogue("talk", revision, "Something else."));
    refused(&s, "media.voiceDesign.create", design("talk", revision, "Hello there."));
    assert_eq!(network.count("POST /audio/speech/speakers"), 1);
    refused(&s, "media.dialogue.create", dialogue("stale", revision + 1, "Hello there."));

    ok(&s, "media.voiceDesign.create", design("voice", revision, "A short line."));
    let voice = wait(&s, "voice", "ready");
    assert_eq!(voice["kind"], "voiceDesign");
    // A short designed voice is an input too, to clone from.
    let preview = voice["previewInput"].as_str().unwrap().to_string();
    assert!(!deletable(&s, &preview));
    assert_eq!(ok(&s, "media.job.previewRelease", json!({"id":"voice"}))["does"].as_array().unwrap().len(), 3);
    let released = ok(&s, "media.job.release", json!({"id":"voice"}));
    assert_eq!((&released["canRelease"], &released["previewInput"]), (&json!(false), &Value::Null));
    assert!(released.get("attachment").is_none());
    refused(&s, "media.input.get", json!({"id":preview}));
    s.close();
}

#[test]
fn an_unknown_audio_answer_is_not_asked_again_and_a_failed_download_retries_alone() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-audio");
    ok(&s, "media.dialogue.create", dialogue("lost", revision, "[audio:unknown] Hello."));
    let lost = wait(&s, "lost", "unknown");
    assert_eq!((&lost["canResume"], &lost["canRetryDownload"]), (&json!(false), &json!(false)));
    refused(&s, "media.audio.resume", json!({"id":"lost"}));

    ok(&s, "media.voiceDesign.create", design("fetch", revision, "[audio:download-failure] A line."));
    assert_eq!(wait(&s, "fetch", "download_failed")["canRetryDownload"], true);
    ok(&s, "media.job.download", json!({"id":"fetch"}));
    wait(&s, "fetch", "ready");
    assert_eq!(network.count("POST /audio/voice/generations"), 1);
    s.close();
}

#[test]
fn followed_audio_tasks_resume_by_hand_and_after_a_restart_without_being_asked_again() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-audio-pending");
    // Stopped while its vendor task is known: only that task is asked about again.
    ok(&s, "media.dialogue.create", dialogue("paused", revision, "[audio:pending] Hello."));
    network.until("GET /audio/tasks/", 1);
    let canceled = ok(&s, "media.job.cancel", json!({"id":"paused"}));
    assert_eq!((&canceled["phase"], &canceled["canResume"]), (&json!("canceled"), &json!(true)));
    assert_eq!(ok(&s, "media.audio.resume", json!({"id":"paused"}))["phase"], "generating");
    wait(&s, "paused", "ready");

    let audio = sample(&s);
    ok(&s, "media.dialogue.create", dialogue("talk", revision, "[audio:pending] Hello."));
    ok(&s, "media.voiceDesign.create", design("voice", revision, "[audio:pending] A line."));
    ok(&s, "media.transcription.create", transcription("words", revision, &audio, false));
    network.until("GET /audio/tasks/", 5);
    for id in ["talk", "voice", "words"] {
        assert_eq!(ok(&s, "media.job.get", json!({"id":id}))["phase"], "generating");
    }
    s.close();
    let reopened = start(dir.path(), &network);
    assert!(wait(&reopened, "talk", "ready")["attachment"]["id"].is_string());
    assert!(wait(&reopened, "voice", "ready")["attachment"]["id"].is_string());
    let words = until(&reopened, "words", "ready and cleaned", |j| j["phase"] == "ready" && j["canCleanup"] == false);
    assert_eq!(words["result"]["segments"].as_array().unwrap().len(), 2);
    assert_eq!(network.count("POST /audio/speech/speakers"), 2);
    assert_eq!(network.count("POST /audio/voice/generations"), 1);
    assert_eq!(network.count("POST /audio/transcriptions"), 1);
    assert_eq!((network.count("POST /files"), network.count("DELETE /files/")), (1, 1));
    reopened.close();
}

#[test]
fn a_voice_is_cloned_once_from_the_users_sample() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-audio");
    let audio = sample(&s);
    let clone = |id: &str, name: &str| json!({"id":id,"connection":"moss","revision":revision,"input":audio,"name":name,"consent":true});
    // Only the user says whose voice a sample is, and says so each time.
    assert_ne!(s.hub.call_as(Caller::Orchestrator, "media.clone.create", clone("mine", "Mine")).biz_code, 0);
    let mut silent = clone("mine", "Mine");
    silent["consent"] = json!(false);
    refused(&s, "media.clone.create", silent);
    refused(
        &s,
        "media.clone.create",
        json!({"id":"picture","connection":"moss","revision":revision,"input":picture(&s),"consent":true}),
    );

    let made = ok(&s, "media.clone.create", clone("mine", "Mine"));
    assert_eq!((&made["kind"], &made["input"]["id"]), (&json!("clone"), &json!(audio)));
    let ready = wait(&s, "mine", "ready");
    assert_eq!(ready["result"]["kind"], "clone");
    assert_eq!(ready["result"]["voice"]["name"], "Mine");
    ok(&s, "media.clone.create", clone("mine", "Mine"));
    assert_eq!(network.count("POST /audio/voices"), 1);
    // The voice keeps its sample until the user releases the job.
    assert!(!deletable(&s, &audio));
    assert_eq!(ok(&s, "media.job.release", json!({"id":"mine"}))["result"]["voice"]["name"], "Mine");
    assert!(deletable(&s, &audio));

    ok(&s, "media.clone.create", clone("refused", "[clone:rejected]"));
    wait(&s, "refused", "failed");
    until(&s, "refused", "its sample let go", |_| deletable(&s, &audio));
    ok(&s, "media.clone.create", clone("lost", "[clone:unknown]"));
    assert_eq!(wait(&s, "lost", "unknown")["canResume"], false);

    // A restart in the middle never clones again: the voice may or may not exist.
    ok(&s, "media.clone.create", clone("cut", "[clone:hold]"));
    network.until("POST /audio/voices", 4);
    s.close();
    let reopened = start(dir.path(), &network);
    assert_eq!(wait(&reopened, "cut", "unknown")["canResume"], false);
    assert_eq!(network.count("POST /audio/voices"), 4);
    reopened.close();
}

#[test]
fn a_transcript_comes_by_task_or_by_stream_and_the_upload_is_deleted_after() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-audio");
    let audio = sample(&s);
    let cleaned = |id: &str, phase: &'static str| until(&s, id, "ended and cleaned", |j| j["phase"] == phase && j["canCleanup"] == false);
    refused(&s, "media.transcription.create", transcription("picture", revision, &picture(&s), false));

    ok(&s, "media.transcription.create", transcription("task", revision, &audio, false));
    let task = cleaned("task", "ready");
    assert_eq!((&task["kind"], &task["prompt"]), (&json!("transcription"), &json!("sample.wav")));
    assert_eq!(task["result"]["text"], "First synthetic speaker. Second synthetic speaker.");
    assert_eq!(task["result"]["segments"][1]["speaker"], "speaker_1");
    assert_eq!((network.count("POST /files"), network.count("DELETE /files/")), (1, 1));
    assert_eq!(ok(&s, "media.audio.previewCleanup", json!({"id":"task"})), json!({"does":[]}));

    ok(&s, "media.transcription.create", transcription("stream", revision, &audio, true));
    let stream = cleaned("stream", "ready");
    assert_eq!(stream["result"]["text"], "First synthetic speaker. Second synthetic speaker.");
    assert_eq!(stream["result"]["segments"].as_array().unwrap().len(), 2);
    assert_eq!(stream["usage"]["inputAudioSeconds"].as_f64(), Some(4.0));
    assert_eq!(network.count("DELETE /files/"), 2);
    // The transcript keeps its recording until the user releases the job.
    assert!(!deletable(&s, &audio));
    ok(&s, "media.job.release", json!({"id":"task"}));
    ok(&s, "media.job.release", json!({"id":"stream"}));
    assert!(deletable(&s, &audio));

    let revision = bind(&s, "test-audio-failure");
    ok(&s, "media.transcription.create", transcription("failed", revision, &audio, false));
    cleaned("failed", "failed");
    until(&s, "failed", "its recording let go", |_| deletable(&s, &audio));

    // A stream cut short keeps what came, and is never asked for again.
    let revision = bind(&s, "test-audio-stream-truncated");
    ok(&s, "media.transcription.create", transcription("cut", revision, &audio, true));
    let cut = wait(&s, "cut", "unknown");
    assert_eq!(cut["result"]["text"], "First synthetic speaker.");
    assert_eq!(cut["canResume"], false);
    refused(&s, "media.audio.resume", json!({"id":"cut"}));
    s.close();
}

#[test]
fn a_vendor_file_that_would_not_go_is_cleaned_when_asked_again() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-audio-cleanup-failure");
    let audio = sample(&s);
    refused(&s, "media.audio.cleanup", json!({"id":"missing"}));
    ok(&s, "media.transcription.create", transcription("words", revision, &audio, false));
    let pending = until(&s, "words", "a pending cleanup", |j| j["phase"] == "ready" && j["problem"] != "");
    assert_eq!(pending["canCleanup"], true);
    assert_eq!(pending["result"]["segments"].as_array().unwrap().len(), 2);
    assert_eq!(ok(&s, "media.audio.previewCleanup", json!({"id":"words"}))["does"].as_array().unwrap().len(), 1);
    let cleaned = ok(&s, "media.audio.cleanup", json!({"id":"words"}));
    assert_eq!((&cleaned["canCleanup"], &cleaned["problem"]), (&json!(false), &json!("")));
    assert_eq!(network.count("DELETE /files/"), 2);
    s.close();
}

#[test]
fn understanding_uploads_asks_once_and_deletes_what_it_uploaded() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-understanding");
    let image = picture(&s);
    refused(&s, "media.understanding.create", understanding("sound", revision, &sample(&s), "What is this?"));
    refused(&s, "media.understanding.create", understanding("stale", revision + 1, &image, "What is this?"));

    let made = ok(&s, "media.understanding.create", understanding("look", revision, &image, "What is this?"));
    assert_eq!(
        (&made["kind"], &made["inputs"][0]["id"], &made["authorization"]),
        (&json!("understanding"), &json!(image), &Value::Null)
    );
    let done = until(&s, "look", "ready and cleaned", |j| j["phase"] == "ready" && j["cleanup"] == "done");
    assert_eq!(done["result"]["text"], "Offline understanding of image input.");
    assert_eq!(done["result"]["usage"]["totalTokens"], 38);
    assert_eq!((&done["canCleanup"], &done["canCancel"]), (&json!(false), &json!(false)));
    assert!(deletable(&s, &image));
    ok(&s, "media.understanding.create", understanding("look", revision, &image, "What is this?"));
    refused(&s, "media.understanding.create", understanding("look", revision, &image, "And this?"));
    assert_eq!(
        (network.count("POST /files"), network.count("POST /responses"), network.count("DELETE /files/")),
        (1, 1, 1)
    );
    assert_eq!(ok(&s, "media.understanding.previewCleanup", json!({"id":"look"})), json!({"does":[]}));
    refused(&s, "media.job.release", json!({"id":"look"}));

    ok(
        &s,
        "media.understanding.create",
        understanding("short", revision, &image, "[understanding:incomplete] Describe."),
    );
    let short = until(&s, "short", "incomplete and cleaned", |j| j["phase"] == "incomplete" && j["cleanup"] == "done");
    assert_eq!(short["result"]["incompleteReason"], "max_output_tokens");

    // The vendor's answer lost: nothing is asked again, and the upload waits for the user to clean it.
    ok(
        &s,
        "media.understanding.create",
        understanding("lost", revision, &image, "[understanding:unknown] Describe."),
    );
    let lost = wait(&s, "lost", "unknown");
    assert_eq!((&lost["cleanup"], &lost["canCleanup"]), (&json!("pending"), &json!(true)));
    assert!(!deletable(&s, &image));
    assert_eq!(
        ok(&s, "media.understanding.previewCleanup", json!({"id":"lost"}))["does"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(ok(&s, "media.understanding.cleanup", json!({"id":"lost"}))["cleanup"], "done");
    assert!(deletable(&s, &image));
    assert_eq!(network.count("DELETE /files/"), 3);

    // A deletion the vendor would not confirm blocks the cleanup until it is asked again.
    ok(
        &s,
        "media.understanding.create",
        understanding("stuck", revision, &image, "[understanding:cleanup-failure] Describe."),
    );
    let stuck = until(&s, "stuck", "a blocked cleanup", |j| j["cleanup"] == "blocked");
    assert_eq!((&stuck["phase"], &stuck["canCleanup"]), (&json!("ready"), &json!(true)));
    assert_eq!(ok(&s, "media.understanding.cleanup", json!({"id":"stuck"}))["cleanup"], "done");
    s.close();
}

#[test]
fn understanding_cut_by_a_restart_is_unknown_and_cleans_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-understanding");
    let image = picture(&s);
    ok(
        &s,
        "media.understanding.create",
        understanding("cut", revision, &image, "[understanding:hold] Describe."),
    );
    network.until("POST /responses", 1);
    assert_eq!(ok(&s, "media.job.get", json!({"id":"cut"}))["phase"], "generating");
    refused(&s, "media.understanding.cleanup", json!({"id":"cut"}));
    let channel = s.chat.default_channel();
    let mut approved = understanding("waiting", revision, &image, "Describe.");
    approved["channel"] = json!(channel);
    assert_eq!(ok(&s, "media.understanding.authorize", approved)["phase"], "authorized");
    s.close();
    let reopened = start(dir.path(), &network);
    let cut = wait(&reopened, "cut", "unknown");
    assert_eq!((&cut["cleanup"], &cut["canCleanup"]), (&json!("pending"), &json!(true)));
    // An approval does not outlive the server that took it.
    assert_eq!(wait(&reopened, "waiting", "canceled")["cleanup"], "done");
    assert_eq!(ok(&reopened, "media.understanding.cleanup", json!({"id":"cut"}))["cleanup"], "done");
    assert!(deletable(&reopened, &image));
    assert_eq!((network.count("POST /responses"), network.count("DELETE /files/")), (1, 1));
    reopened.close();
}

#[test]
fn an_orchestrator_makes_audio_and_starts_understanding_only_with_the_users_word() {
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-understanding");
    let image = picture(&s);
    let channel = s.chat.default_channel();
    let mut approved = understanding("look", revision, &image, "What is this?");
    approved["channel"] = json!("no-such-channel");
    refused(&s, "media.understanding.authorize", approved.clone());
    approved["channel"] = json!(channel);
    let waiting = ok(&s, "media.understanding.authorize", approved.clone());
    assert_eq!(
        (&waiting["phase"], &waiting["authorization"]["channel"]),
        (&json!("authorized"), &json!(channel))
    );
    assert_eq!(ok(&s, "media.understanding.authorize", approved)["phase"], "authorized");
    // Asked directly it would be another request under the same id.
    refused(&s, "media.understanding.create", understanding("look", revision, &image, "What is this?"));
    assert_eq!(network.count("POST /files"), 0);

    let (tools, route) = tools(&s, "elsewhere");
    let tool = |name: &str| tools.iter().find(|t| t.spec().name == name).unwrap();
    let start = tool("media_understanding_start");
    assert!(start.execute(&json!({"id":"look"})).is_error);
    route.lock().unwrap().user = true;
    assert!(start.execute(&json!({"id":"look"})).is_error);
    assert_eq!(ok(&s, "media.job.get", json!({"id":"look"}))["phase"], "authorized");
    route.lock().unwrap().channel = channel.clone();
    let started = start.execute(&json!({"id":"look"}));
    assert!(!started.is_error, "{}", started.text);
    let done = until(&s, "look", "ready and cleaned", |j| j["phase"] == "ready" && j["cleanup"] == "done");
    assert_eq!(done["source"], json!({"kind":"orchestrator","agent":"orchestrator","channel":channel}));
    assert!(!start.execute(&json!({"id":"look"})).is_error);
    assert_eq!((network.count("POST /files"), network.count("POST /responses")), (1, 1));

    // An approval the user withdraws lets go of its inputs and can no longer be started.
    let mut second = understanding("withdrawn", revision, &image, "And this?");
    second["channel"] = json!(channel);
    ok(&s, "media.understanding.authorize", second);
    assert!(!deletable(&s, &image));
    assert_eq!(ok(&s, "media.job.cancel", json!({"id":"withdrawn"}))["cleanup"], "done");
    assert!(deletable(&s, &image));
    assert!(!start.execute(&json!({"id":"withdrawn"})).is_error);
    assert_eq!(ok(&s, "media.job.get", json!({"id":"withdrawn"}))["phase"], "canceled");

    let talk = tool("media_dialogue_create");
    route.lock().unwrap().user = false;
    assert!(talk.execute(&dialogue("talk", revision, "Hello there.")).is_error);
    route.lock().unwrap().user = true;
    let asked = talk.execute(&dialogue("talk", revision, "Hello there."));
    assert!(!asked.is_error, "{}", asked.text);
    assert_eq!(wait(&s, "talk", "ready")["source"]["kind"], "orchestrator");
    let voice = tool("media_voice_design_create").execute(&design("voice", revision, "A short line."));
    assert!(!voice.is_error, "{}", voice.text);
    assert_eq!(wait(&s, "voice", "ready")["source"]["agent"], "orchestrator");
    s.close();
}

#[test]
fn regression_job_admission_rolls_back_input_pins_without_a_second_write() {
    use sqlx::ConnectOptions;
    let dir = tempfile::tempdir().unwrap();
    let network = Network::new();
    let s = start(dir.path(), &network);
    let revision = bind(&s, "test-understanding");
    let image = picture(&s);
    let mut approved = understanding("atomic", revision, &image, "Describe");
    approved["channel"] = json!(s.chat.default_channel());
    let mut db = pollster::block_on(sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("server.db")).connect()).unwrap();
    pollster::block_on(
        sqlx::raw_sql(
            "CREATE TRIGGER reject_job BEFORE INSERT ON media_job BEGIN SELECT RAISE(ABORT,'job store failed'); END;
         CREATE TRIGGER reject_unpin BEFORE DELETE ON media_input_pin BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;",
        )
        .execute(&mut db),
    )
    .unwrap();
    refused(&s, "media.understanding.authorize", approved.clone());
    assert!(deletable(&s, &image));
    refused(&s, "media.job.get", json!({"id":"atomic"}));
    pollster::block_on(sqlx::raw_sql("DROP TRIGGER reject_job; DROP TRIGGER reject_unpin;").execute(&mut db)).unwrap();

    std::thread::scope(|scope| {
        let duplicate = scope.spawn(|| ok(&s, "media.understanding.authorize", approved.clone()));
        assert_eq!(ok(&s, "media.understanding.authorize", approved.clone())["phase"], "authorized");
        assert_eq!(duplicate.join().unwrap()["phase"], "authorized");
    });
    assert!(!deletable(&s, &image));
    let different = picture(&s);
    let mut conflicting = approved;
    conflicting["inputs"] = json!([different]);
    refused(&s, "media.understanding.authorize", conflicting);
    assert!(!deletable(&s, &image));
    assert!(deletable(&s, &different));
    assert_eq!(network.count("POST /files"), 0);
    ok(&s, "media.job.cancel", json!({"id":"atomic"}));
    assert!(deletable(&s, &image));
    s.close();
}
