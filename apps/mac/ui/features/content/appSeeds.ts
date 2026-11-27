import type { NoteFileWriteItem } from "@vibevalley/protocol";

export type AppTemplateSeed = "protoFocusStudio" | "protoSynthPad" | "protoParticleLab" | "protoTokenCalculator" | "protoCssGlassStudio" | "protoDeskKanban";

function textWriteItem(path: string, content: string, mime: string): NoteFileWriteItem {
  return { path, content, encoding: "utf8", mime };
}

function escapeHtml(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function buildFocusStudio(title: string): NoteFileWriteItem[] {
  const safe = escapeHtml(title);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="pulse-dot"></span>
        <h1>${safe}</h1>
      </div>
      <div class="stats">
        <span class="pill" id="streak-pill">0 sessions</span>
        <span class="hint">Space · R</span>
      </div>
    </header>

    <main class="grid">
      <section class="timer-card">
        <div class="modes" id="mode-tabs">
          <button type="button" class="mode active" data-mode="focus" data-min="25">Focus 25m</button>
          <button type="button" class="mode" data-mode="deep" data-min="50">Deep 50m</button>
          <button type="button" class="mode" data-mode="short" data-min="5">Break 5m</button>
          <button type="button" class="mode" data-mode="long" data-min="15">Rest 15m</button>
        </div>

        <div class="ring-wrap">
          <svg class="ring" viewBox="0 0 240 240">
            <circle class="ring-track" cx="120" cy="120" r="102" />
            <circle class="ring-progress" id="ring-progress" cx="120" cy="120" r="102" />
          </svg>
          <div class="clock-center">
            <div class="clock" id="clock">25:00</div>
            <div class="phase-label" id="phase-label">READY TO FOCUS</div>
          </div>
        </div>

        <div class="controls">
          <button type="button" class="btn ghost" id="sub5">-5m</button>
          <button type="button" class="btn primary" id="toggle-btn">Start</button>
          <button type="button" class="btn ghost" id="reset-btn">Reset</button>
          <button type="button" class="btn ghost" id="add5">+5m</button>
        </div>
      </section>

      <aside class="side-col">
        <section class="panel">
          <div class="panel-head">
            <h2>Ambient Soundscape</h2>
            <span class="vol-readout" id="vol-readout">35%</span>
          </div>
          <div class="sound-grid" id="sound-grid">
            <button type="button" class="sound-chip active" data-sound="off">Silent</button>
            <button type="button" class="sound-chip" data-sound="rain">Rain</button>
            <button type="button" class="sound-chip" data-sound="brown">Warm Noise</button>
            <button type="button" class="sound-chip" data-sound="pad">Focus Pad</button>
          </div>
          <input id="vol-slider" type="range" min="0" max="100" value="35" />
        </section>

        <section class="panel tasks-panel">
          <div class="panel-head">
            <h2>Session Queue</h2>
            <span class="vol-readout" id="task-count">0/0</span>
          </div>
          <form class="task-form" id="task-form">
            <input id="task-input" type="text" placeholder="Add a focus target..." maxlength="72" />
            <button type="submit" class="btn primary small">Add</button>
          </form>
          <ul class="task-list" id="task-list"></ul>
        </section>
      </aside>
    </main>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const css = `:root {
  --bg: #0f110f;
  --surface: #171a16;
  --surface-2: #1f231e;
  --border: rgba(255, 255, 255, 0.08);
  --text: #f3f2ed;
  --muted: #9b998f;
  --accent: #7ec850;
  --accent-soft: rgba(126, 200, 80, 0.16);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(circle at 18% 12%, rgba(126, 200, 80, 0.12), transparent 45%),
              radial-gradient(circle at 86% 84%, rgba(76, 155, 224, 0.09), transparent 40%),
              var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;
  display: flex;
  justify-content: center;
  padding: 20px;
}
.shell { width: 100%; max-width: 920px; display: flex; flex-direction: column; gap: 16px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.pulse-dot { width: 9px; height: 9px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
.stats { display: flex; align-items: center; gap: 8px; }
.pill { padding: 4px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 600; }
.hint { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 3px 7px; }
.grid { display: grid; grid-template-columns: minmax(280px, 1.15fr) minmax(250px, 0.9fr); gap: 16px; align-items: stretch; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
.timer-card, .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 18px; }
.timer-card { display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 18px; }
.modes { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
.mode, .sound-chip, .btn {
  border: 1px solid var(--border); background: var(--surface-2); color: var(--muted);
  border-radius: 10px; padding: 6px 11px; font-size: 12px; font-weight: 500; cursor: pointer; transition: all .15s ease;
}
.mode.active, .sound-chip.active { background: var(--accent-soft); color: var(--accent); border-color: rgba(126, 200, 80, 0.45); }
.ring-wrap { position: relative; width: 224px; height: 224px; display: grid; place-items: center; }
.ring { width: 224px; height: 224px; transform: rotate(-90deg); }
.ring-track { fill: none; stroke: rgba(255,255,255,0.07); stroke-width: 10; }
.ring-progress { fill: none; stroke: var(--accent); stroke-width: 10; stroke-linecap: round; transition: stroke-dashoffset .35s linear; }
.clock-center { position: absolute; text-align: center; }
.clock { font-family: ui-monospace, monospace; font-size: 44px; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.phase-label { margin-top: 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; color: var(--muted); }
.controls { display: flex; align-items: center; gap: 8px; }
.btn.primary { background: var(--accent); color: #0c1208; border-color: transparent; font-weight: 700; padding: 8px 18px; }
.btn.primary.small { padding: 7px 12px; }
.btn.ghost:hover { color: var(--text); border-color: rgba(255,255,255,0.2); }
.side-col { display: flex; flex-direction: column; gap: 14px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.panel-head h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text); }
.vol-readout { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.sound-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 10px; }
input[type="range"] { width: 100%; accent-color: var(--accent); }
.tasks-panel { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.task-form { display: flex; gap: 6px; }
.task-form input {
  flex: 1; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
  color: var(--text); padding: 7px 10px; font-size: 12px; outline: none;
}
.task-form input:focus { border-color: var(--accent); }
.task-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 210px; overflow: auto; }
.task-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 10px;
  background: var(--surface-2); border: 1px solid var(--border); font-size: 12px;
}
.task-item.done span { text-decoration: line-through; color: var(--muted); }
.task-item button.rm { margin-left: auto; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; }
`;

  const js = `const CIRC = 2 * Math.PI * 102;
const ring = document.getElementById("ring-progress");
const clockEl = document.getElementById("clock");
const phaseEl = document.getElementById("phase-label");
const toggleBtn = document.getElementById("toggle-btn");
const streakPill = document.getElementById("streak-pill");
const volSlider = document.getElementById("vol-slider");
const volReadout = document.getElementById("vol-readout");
const taskList = document.getElementById("task-list");
const taskCount = document.getElementById("task-count");
const taskInput = document.getElementById("task-input");

ring.style.strokeDasharray = String(CIRC);

const safeStore = (() => {
  const mem = new Map();
  return {
    get(k, fb) { try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : fb; } catch { return mem.has(k) ? mem.get(k) : fb; } },
    set(k, v) { mem.set(k, v); try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
})();

let durationSec = 25 * 60;
let remainingSec = durationSec;
let running = false;
let ticker = null;
let sessions = safeStore.get("vv-focus-sessions", 0);
let tasks = safeStore.get("vv-focus-tasks", [
  { id: "1", text: "Outline key deliverable milestones", done: false },
  { id: "2", text: "Ship prototype & verify interactions", done: false },
]);

let audioCtx = null;
let masterGain = null;
let activeNodes = [];
let activeSound = "off";

function stopAudio() {
  activeNodes.forEach((n) => { try { n.stop?.(); n.disconnect?.(); } catch {} });
  activeNodes = [];
}

function startSound(kind) {
  stopAudio();
  activeSound = kind;
  if (kind === "off") return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) {
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = (Number(volSlider.value) / 100) * 0.25;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();

  if (kind === "rain" || kind === "brown") {
    const len = audioCtx.sampleRate * 2;
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.04 * white) / 1.04;
      data[i] = kind === "brown" ? lastOut * 3.2 : white * 0.45;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = audioCtx.createBiquadFilter();
    filter.type = kind === "rain" ? "bandpass" : "lowpass";
    filter.frequency.value = kind === "rain" ? 1150 : 340;
    src.connect(filter);
    filter.connect(masterGain);
    src.start();
    activeNodes.push(src, filter);
  } else if (kind === "pad") {
    [130.81, 196.0, 246.94].forEach((freq) => {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.value = 0.14;
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      activeNodes.push(osc, g);
    });
  }
}

function playBell() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = audioCtx || new Ctx();
  if (ctx.state === "suspended") void ctx.resume();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(659.25, ctx.currentTime);
  g.gain.setValueAtTime(0.18, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.1);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 1.15);
}

function renderClock() {
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  clockEl.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  const frac = durationSec > 0 ? remainingSec / durationSec : 0;
  ring.style.strokeDashoffset = String(CIRC * (1 - frac));
  phaseEl.textContent = running ? "IN FLOW" : remainingSec === 0 ? "SESSION COMPLETE" : "READY TO FOCUS";
  toggleBtn.textContent = running ? "Pause" : remainingSec === 0 ? "Restart" : "Start";
  streakPill.textContent = sessions + " session" + (sessions === 1 ? "" : "s");
}

function renderTasks() {
  taskList.replaceChildren();
  const doneCount = tasks.filter((t) => t.done).length;
  taskCount.textContent = doneCount + "/" + tasks.length;
  tasks.forEach((item) => {
    const li = document.createElement("li");
    li.className = "task-item" + (item.done ? " done" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.done;
    cb.addEventListener("change", () => {
      item.done = cb.checked;
      safeStore.set("vv-focus-tasks", tasks);
      renderTasks();
    });
    const span = document.createElement("span");
    span.textContent = item.text;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      tasks = tasks.filter((t) => t.id !== item.id);
      safeStore.set("vv-focus-tasks", tasks);
      renderTasks();
    });
    li.append(cb, span, rm);
    taskList.append(li);
  });
}

function toggleRun() {
  if (running) {
    running = false;
    clearInterval(ticker);
    renderClock();
    return;
  }
  if (remainingSec <= 0) remainingSec = durationSec;
  running = true;
  renderClock();
  ticker = setInterval(() => {
    remainingSec = Math.max(0, remainingSec - 1);
    if (remainingSec === 0) {
      running = false;
      clearInterval(ticker);
      sessions += 1;
      safeStore.set("vv-focus-sessions", sessions);
      playBell();
    }
    renderClock();
  }, 1000);
}

function resetClock() {
  running = false;
  clearInterval(ticker);
  remainingSec = durationSec;
  renderClock();
}

toggleBtn.addEventListener("click", toggleRun);
document.getElementById("reset-btn").addEventListener("click", resetClock);
document.getElementById("sub5").addEventListener("click", () => {
  remainingSec = Math.max(60, remainingSec - 300);
  if (!running) durationSec = Math.max(durationSec, remainingSec);
  renderClock();
});
document.getElementById("add5").addEventListener("click", () => {
  remainingSec += 300;
  durationSec = Math.max(durationSec, remainingSec);
  renderClock();
});

document.querySelectorAll("#mode-tabs .mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mode-tabs .mode").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    durationSec = Number(btn.dataset.min || 25) * 60;
    resetClock();
  });
});

document.querySelectorAll("#sound-grid .sound-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#sound-grid .sound-chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    startSound(btn.dataset.sound || "off");
  });
});

volSlider.addEventListener("input", () => {
  volReadout.textContent = volSlider.value + "%";
  if (masterGain) masterGain.gain.value = (Number(volSlider.value) / 100) * 0.25;
});

document.getElementById("task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const txt = taskInput.value.trim();
  if (!txt) return;
  tasks.push({ id: String(Date.now()), text: txt, done: false });
  taskInput.value = "";
  safeStore.set("vv-focus-tasks", tasks);
  renderTasks();
});

window.addEventListener("keydown", (e) => {
  if (document.activeElement === taskInput) return;
  if (e.code === "Space") { e.preventDefault(); toggleRun(); }
  else if (e.key === "r" || e.key === "R") { resetClock(); }
});

renderClock();
renderTasks();
`;

  return [
    textWriteItem("structure/index.html", html, "text/html"),
    textWriteItem("structure/styles.css", css, "text/css"),
    textWriteItem("structure/app.js", js, "application/javascript"),
  ];
}

function buildSynthPad(title: string): NoteFileWriteItem[] {
  const safe = escapeHtml(title);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="studio">
    <header class="bar">
      <div>
        <h1>${safe}</h1>
        <p class="sub">16-step WebAudio sequencer &amp; pentatonic keys (A–K)</p>
      </div>
      <div class="transport">
        <button type="button" class="btn primary" id="play-btn">Play</button>
        <label class="ctrl">BPM <strong id="bpm-val">108</strong><input id="bpm" type="range" min="68" max="155" value="108" /></label>
        <select id="preset">
          <option value="lofi">Lo-Fi Chill</option>
          <option value="synth">Synthwave</option>
          <option value="minimal">Minimal</option>
          <option value="clear">Clear</option>
        </select>
      </div>
    </header>

    <canvas id="scope" width="760" height="84"></canvas>

    <section class="sequencer" id="seq"></section>

    <section class="keys" id="keys"></section>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const css = `:root {
  --bg: #111015;
  --panel: #191820;
  --pad: #24232e;
  --line: rgba(255,255,255,0.09);
  --ink: #f5f4f8;
  --muted: #9b97ab;
  --accent: #f59e0b;
  --teal: #2dd4bf;
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 0%, rgba(245,158,11,0.12), transparent 45%), var(--bg);
  color: var(--ink); font-family: ui-sans-serif, -apple-system, sans-serif; padding: 20px; display: flex; justify-content: center;
}
.studio { width: 100%; max-width: 860px; display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
h1 { margin: 0; font-size: 18px; }
.sub { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.transport { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.ctrl { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 5px 10px; }
.ctrl strong { color: var(--ink); font-family: ui-monospace, monospace; }
.btn, select {
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 10px; padding: 7px 14px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn.primary { background: var(--accent); color: #161004; border-color: transparent; }
canvas { width: 100%; height: 84px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.sequencer { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.track { display: grid; grid-template-columns: 74px repeat(16, 1fr); gap: 5px; align-items: center; }
.track-name { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.step {
  height: 30px; border-radius: 7px; border: 1px solid var(--line); background: var(--pad); cursor: pointer; transition: transform .08s ease;
}
.step.on { background: var(--accent); border-color: rgba(255,255,255,0.3); }
.step.bass.on { background: var(--teal); }
.step.playhead { outline: 2px solid #ffffff; transform: scale(1.06); }
.keys { display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; }
.key {
  padding: 14px 8px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel);
  color: var(--ink); font-family: ui-monospace, monospace; font-size: 12px; cursor: pointer; text-align: center;
}
.key.hit { background: var(--teal); color: #051614; border-color: transparent; }
`;

  const js = `const TRACKS = [
  { id: "kick", label: "KICK", cls: "" },
  { id: "snare", label: "SNARE", cls: "" },
  { id: "hat", label: "HI-HAT", cls: "" },
  { id: "bass", label: "SUB", cls: "bass" },
];
const PRESETS = {
  lofi: {
    kick:  [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,1],
    hat:   [1,0,1,0, 1,0,1,1, 1,0,1,0, 1,1,1,0],
    bass:  [1,0,0,1, 0,0,0,0, 1,0,1,0, 0,0,1,0],
  },
  synth: {
    kick:  [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],
    snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
    hat:   [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,1],
    bass:  [1,1,0,1, 1,0,1,0, 1,1,0,1, 0,1,1,0],
  },
  minimal: {
    kick:  [1,0,0,0, 1,0,0,0, 1,0,0,1, 1,0,0,0],
    snare: [0,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0],
    hat:   [0,0,1,0, 0,1,1,0, 0,0,1,0, 0,1,1,1],
    bass:  [1,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0],
  },
  clear: {
    kick: Array(16).fill(0), snare: Array(16).fill(0), hat: Array(16).fill(0), bass: Array(16).fill(0),
  },
};
const NOTES = [
  { key: "A", note: "C4", freq: 261.63 },
  { key: "S", note: "D4", freq: 293.66 },
  { key: "D", note: "E4", freq: 329.63 },
  { key: "F", note: "G4", freq: 392.00 },
  { key: "G", note: "A4", freq: 440.00 },
  { key: "H", note: "C5", freq: 523.25 },
  { key: "J", note: "D5", freq: 587.33 },
  { key: "K", note: "E5", freq: 659.25 },
];

let grid = structuredClone(PRESETS.lofi);
let playing = false;
let step = 0;
let timer = null;
let ctx = null;
let analyser = null;

function ensureAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) {
    ctx = new Ctx();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function triggerKick(t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(145, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
  g.gain.setValueAtTime(0.65, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g); g.connect(analyser);
  o.start(t); o.stop(t + 0.24);
}

function triggerSnare(t) {
  const len = Math.floor(ctx.sampleRate * 0.14);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  s.connect(f); f.connect(g); g.connect(analyser);
  s.start(t);
}

function triggerHat(t) {
  const len = Math.floor(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 5200;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  s.connect(f); f.connect(g); g.connect(analyser);
  s.start(t);
}

function triggerTone(freq, dur = 0.28, wave = "triangle", gainAmt = 0.22) {
  if (!ensureAudio()) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = wave;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gainAmt, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(analyser);
  o.start(t); o.stop(t + dur + 0.02);
}

const seqEl = document.getElementById("seq");
function renderSeq() {
  seqEl.replaceChildren();
  TRACKS.forEach((tr) => {
    const row = document.createElement("div");
    row.className = "track";
    const lbl = document.createElement("span");
    lbl.className = "track-name";
    lbl.textContent = tr.label;
    row.append(lbl);
    grid[tr.id].forEach((val, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "step " + tr.cls + (val ? " on" : "") + (playing && idx === step ? " playhead" : "");
      btn.addEventListener("click", () => {
        grid[tr.id][idx] = grid[tr.id][idx] ? 0 : 1;
        renderSeq();
      });
      row.append(btn);
    });
    seqEl.append(row);
  });
}

function tick() {
  if (!ensureAudio()) return;
  const t = ctx.currentTime;
  if (grid.kick[step]) triggerKick(t);
  if (grid.snare[step]) triggerSnare(t);
  if (grid.hat[step]) triggerHat(t);
  if (grid.bass[step]) triggerTone(step % 8 === 3 ? 82.41 : 65.41, 0.22, "sawtooth", 0.14);
  renderSeq();
  step = (step + 1) % 16;
}

const bpmInput = document.getElementById("bpm");
const bpmVal = document.getElementById("bpm-val");
const playBtn = document.getElementById("play-btn");

function startLoop() {
  clearInterval(timer);
  const stepMs = (60 / Number(bpmInput.value) / 4) * 1000;
  timer = setInterval(tick, stepMs);
}

playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "Stop" : "Play";
  if (playing) {
    step = 0;
    tick();
    startLoop();
  } else {
    clearInterval(timer);
    renderSeq();
  }
});

bpmInput.addEventListener("input", () => {
  bpmVal.textContent = bpmInput.value;
  if (playing) startLoop();
});

document.getElementById("preset").addEventListener("change", (e) => {
  grid = structuredClone(PRESETS[e.target.value] || PRESETS.lofi);
  renderSeq();
});

const keysEl = document.getElementById("keys");
const keyMap = new Map();
NOTES.forEach((n) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "key";
  b.textContent = n.note + " (" + n.key + ")";
  const fire = () => {
    triggerTone(n.freq, 0.45, "triangle", 0.24);
    b.classList.add("hit");
    setTimeout(() => b.classList.remove("hit"), 140);
  };
  b.addEventListener("click", fire);
  keyMap.set(n.key.toLowerCase(), fire);
  keysEl.append(b);
});

window.addEventListener("keydown", (e) => {
  const fn = keyMap.get(e.key.toLowerCase());
  if (fn) fn();
});

const canvas = document.getElementById("scope");
const g2d = canvas.getContext("2d");
const waveBuf = new Uint8Array(128);
function drawScope() {
  g2d.clearRect(0, 0, canvas.width, canvas.height);
  g2d.strokeStyle = "#2dd4bf";
  g2d.lineWidth = 2;
  g2d.beginPath();
  if (analyser) {
    analyser.getByteTimeDomainData(waveBuf);
    for (let i = 0; i < waveBuf.length; i++) {
      const x = (i / (waveBuf.length - 1)) * canvas.width;
      const y = (waveBuf[i] / 255) * canvas.height;
      if (i === 0) g2d.moveTo(x, y); else g2d.lineTo(x, y);
    }
  } else {
    g2d.moveTo(0, canvas.height / 2);
    g2d.lineTo(canvas.width, canvas.height / 2);
  }
  g2d.stroke();
  requestAnimationFrame(drawScope);
}

renderSeq();
drawScope();
`;

  return [
    textWriteItem("structure/index.html", html, "text/html"),
    textWriteItem("structure/styles.css", css, "text/css"),
    textWriteItem("structure/app.js", js, "application/javascript"),
  ];
}

function buildParticleLab(title: string): NoteFileWriteItem[] {
  const safe = escapeHtml(title);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <canvas id="canvas"></canvas>
  <div class="hud">
    <div class="row">
      <h1>${safe}</h1>
      <div class="btns">
        <button type="button" id="toggle-run">Pause</button>
        <button type="button" id="burst-btn">Burst</button>
        <button type="button" id="clear-btn">Clear</button>
      </div>
    </div>
    <div class="sliders">
      <label>Palette
        <select id="palette">
          <option value="aurora">Aurora</option>
          <option value="paper">Papertrails</option>
          <option value="sunset">Solar Flare</option>
          <option value="ink">Sumi Ink</option>
        </select>
      </label>
      <label>Particles <input id="count" type="range" min="180" max="1400" value="680" /></label>
      <label>Speed <input id="speed" type="range" min="1" max="10" value="4" /></label>
      <label>Turbulence <input id="turb" type="range" min="1" max="12" value="5" /></label>
    </div>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const css = `* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0c0d10; font-family: ui-sans-serif, -apple-system, sans-serif; }
canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
.hud {
  position: fixed; left: 16px; bottom: 16px; right: 16px; max-width: 720px; margin: 0 auto;
  background: rgba(18, 20, 24, 0.78); backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 12px 14px; color: #f3f4f6;
  display: flex; flex-direction: column; gap: 10px;
}
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h1 { margin: 0; font-size: 14px; font-weight: 600; }
.btns { display: flex; gap: 6px; }
button, select {
  border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.08); color: #f3f4f6;
  border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer;
}
button:hover { background: rgba(255,255,255,0.16); }
.sliders { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 10px; font-size: 11px; color: #b5bac4; }
.sliders label { display: flex; flex-direction: column; gap: 4px; }
input[type="range"] { width: 100%; accent-color: #7ee787; }
`;

  const js = `const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const PALETTES = {
  aurora: ["#34d399", "#22d3ee", "#818cf8", "#c084fc"],
  paper:  ["#7ec850", "#eab308", "#38bdf8", "#f97316"],
  sunset: ["#fb7185", "#f97316", "#facc15", "#f43f5e"],
  ink:    ["#e7e5e4", "#a8a29e", "#78716c", "#f5f5f4"],
};

let w = 0, h = 0, dpr = 1;
let paused = false;
let paletteKey = "aurora";
let particles = [];
const mouse = { x: 0, y: 0, active: false };

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function makeParticle(cx, cy) {
  const cols = PALETTES[paletteKey];
  return {
    x: cx ?? Math.random() * w,
    y: cy ?? Math.random() * h,
    vx: 0, vy: 0,
    life: Math.random() * 140 + 60,
    color: cols[Math.floor(Math.random() * cols.length)],
  };
}

function syncCount() {
  const target = Number(document.getElementById("count").value);
  while (particles.length < target) particles.push(makeParticle());
  if (particles.length > target) particles.length = target;
}

function step(timeMs) {
  requestAnimationFrame(step);
  if (paused) return;
  const t = timeMs * 0.00035;
  const speed = Number(document.getElementById("speed").value) * 0.45;
  const scale = Number(document.getElementById("turb").value) * 0.0011;

  ctx.fillStyle = "rgba(12, 13, 16, 0.09)";
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const angle = Math.sin(p.x * scale + t) * Math.cos(p.y * scale - t) * Math.PI * 2;
    p.vx = p.vx * 0.85 + Math.cos(angle) * speed * 0.4;
    p.vy = p.vy * 0.85 + Math.sin(angle) * speed * 0.4;

    if (mouse.active) {
      const dx = mouse.x - p.x;
      const dy = mouse.y - p.y;
      const dist = Math.hypot(dx, dy) + 1;
      if (dist < 180) {
        p.vx += (dx / dist) * 0.65;
        p.vy += (dy / dist) * 0.65;
      }
    }

    const nx = p.x + p.vx;
    const ny = p.y + p.vy;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    p.x = nx;
    p.y = ny;
    p.life -= 1;
    if (p.life <= 0 || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
      particles[i] = makeParticle();
    }
  }
}

window.addEventListener("resize", resize);
canvas.addEventListener("pointermove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; });
canvas.addEventListener("pointerleave", () => { mouse.active = false; });
canvas.addEventListener("click", (e) => {
  for (let i = 0; i < 60; i++) {
    const p = makeParticle(e.clientX, e.clientY);
    const a = Math.random() * Math.PI * 2;
    p.vx = Math.cos(a) * 4;
    p.vy = Math.sin(a) * 4;
    particles[i % particles.length] = p;
  }
});

document.getElementById("palette").addEventListener("change", (e) => {
  paletteKey = e.target.value;
  particles = particles.map(() => makeParticle());
});
document.getElementById("count").addEventListener("input", syncCount);
document.getElementById("toggle-run").addEventListener("click", (e) => {
  paused = !paused;
  e.target.textContent = paused ? "Resume" : "Pause";
});
document.getElementById("burst-btn").addEventListener("click", () => {
  const cx = w / 2, cy = h / 2;
  particles.forEach((p) => { p.x = cx; p.y = cy; const a = Math.random() * 6.28; p.vx = Math.cos(a) * 5; p.vy = Math.sin(a) * 5; });
});
document.getElementById("clear-btn").addEventListener("click", () => {
  ctx.fillStyle = "#0c0d10";
  ctx.fillRect(0, 0, w, h);
});

resize();
syncCount();
requestAnimationFrame(step);
`;

  return [
    textWriteItem("structure/index.html", html, "text/html"),
    textWriteItem("structure/styles.css", css, "text/css"),
    textWriteItem("structure/app.js", js, "application/javascript"),
  ];
}

function buildTokenCalculator(title: string): NoteFileWriteItem[] {
  const safe = escapeHtml(title);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="wrap">
    <header class="head">
      <div>
        <h1>${safe}</h1>
        <p>Interactive monthly AI inference cost &amp; cache savings simulator</p>
      </div>
      <div class="presets">
        <button type="button" class="preset active" data-preset="indie">Lean Indie</button>
        <button type="button" class="preset" data-preset="team">Team SaaS</button>
        <button type="button" class="preset" data-preset="scale">Enterprise</button>
        <button type="button" class="copy-btn" id="copy-md">Copy Summary</button>
      </div>
    </header>

    <section class="layout">
      <div class="controls card">
        <label class="slider-row"><span>Daily Active Users</span><strong id="v-dau">5,000</strong><input id="dau" type="range" min="100" max="100000" step="100" value="5000" /></label>
        <label class="slider-row"><span>Prompts / User / Day</span><strong id="v-prompts">12</strong><input id="prompts" type="range" min="1" max="60" value="12" /></label>
        <label class="slider-row"><span>Avg Input Tokens</span><strong id="v-in">2,400</strong><input id="inTok" type="range" min="200" max="16000" step="100" value="2400" /></label>
        <label class="slider-row"><span>Avg Output Tokens</span><strong id="v-out">650</strong><input id="outTok" type="range" min="100" max="4000" step="50" value="650" /></label>
        <label class="slider-row"><span>Prompt Cache Hit Rate</span><strong id="v-cache">55%</strong><input id="cache" type="range" min="0" max="90" step="5" value="55" /></label>
      </div>

      <div class="results card">
        <div class="totals" id="totals"></div>
        <div class="bars" id="bars"></div>
      </div>
    </section>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const css = `:root { --bg: #f6f5f0; --card: #ffffff; --ink: #1c1917; --muted: #6e685f; --line: #e4e1d8; --accent: #4d7a2a; --water: #2b7a9b; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, -apple-system, sans-serif; padding: 20px; }
.wrap { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
h1 { margin: 0; font-size: 20px; }
.head p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
button { border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 9px; padding: 6px 11px; font-size: 12px; font-weight: 600; cursor: pointer; }
button.active { background: var(--accent); color: #fff; border-color: transparent; }
button.copy-btn { background: #1c1917; color: #fff; border-color: transparent; }
.layout { display: grid; grid-template-columns: 1fr 1.2fr; gap: 16px; }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
.controls { display: flex; flex-direction: column; gap: 14px; }
.slider-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; font-size: 12px; color: var(--muted); }
.slider-row strong { font-family: ui-monospace, monospace; color: var(--ink); }
.slider-row input { grid-column: 1 / -1; width: 100%; accent-color: var(--accent); }
.results { display: flex; flex-direction: column; gap: 16px; }
.totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
.stat span { display: block; font-size: 11px; color: var(--muted); }
.stat strong { display: block; margin-top: 4px; font-size: 18px; font-family: ui-monospace, monospace; }
.bars { display: flex; flex-direction: column; gap: 10px; }
.tier { display: flex; flex-direction: column; gap: 5px; }
.tier-top { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; }
.bar-bg { height: 12px; border-radius: 999px; background: var(--bg); overflow: hidden; display: flex; }
.bar-in { background: var(--water); height: 100%; }
.bar-out { background: var(--accent); height: 100%; }
`;

  const js = `const TIERS = [
  { name: "Fast / Haiku-class", inPerM: 0.80, outPerM: 4.00 },
  { name: "Balanced / Sonnet-class", inPerM: 3.00, outPerM: 15.00 },
  { name: "Flagship / Opus-class", inPerM: 15.00, outPerM: 75.00 },
];
const PRESETS = {
  indie:  { dau: 1200, prompts: 10, inTok: 1800, outTok: 500, cache: 40 },
  team: { dau: 12000, prompts: 14, inTok: 2800, outTok: 750, cache: 60 },
  scale:  { dau: 60000, prompts: 20, inTok: 4200, outTok: 950, cache: 75 },
};

const els = {
  dau: document.getElementById("dau"),
  prompts: document.getElementById("prompts"),
  inTok: document.getElementById("inTok"),
  outTok: document.getElementById("outTok"),
  cache: document.getElementById("cache"),
};

function fmtUsd(n) { return "$" + Math.round(n).toLocaleString("en-US"); }

function compute() {
  const dau = Number(els.dau.value);
  const prompts = Number(els.prompts.value);
  const inTok = Number(els.inTok.value);
  const outTok = Number(els.outTok.value);
  const cacheRate = Number(els.cache.value) / 100;

  document.getElementById("v-dau").textContent = dau.toLocaleString("en-US");
  document.getElementById("v-prompts").textContent = String(prompts);
  document.getElementById("v-in").textContent = inTok.toLocaleString("en-US");
  document.getElementById("v-out").textContent = outTok.toLocaleString("en-US");
  document.getElementById("v-cache").textContent = Math.round(cacheRate * 100) + "%";

  const reqsMonth = dau * prompts * 30;
  const effInM = (reqsMonth * inTok * (1 - cacheRate * 0.75)) / 1e6;
  const outM = (reqsMonth * outTok) / 1e6;

  const totalsEl = document.getElementById("totals");
  totalsEl.innerHTML = "";
  [
    ["Monthly Requests", (reqsMonth / 1e6).toFixed(2) + "M"],
    ["Effective Input Tokens", effInM.toFixed(1) + "M"],
    ["Output Tokens", outM.toFixed(1) + "M"],
  ].forEach(([k, v]) => {
    const d = document.createElement("div"); d.className = "stat";
    const s = document.createElement("span"); s.textContent = k;
    const st = document.createElement("strong"); st.textContent = v;
    d.append(s, st); totalsEl.append(d);
  });

  const rows = TIERS.map((t) => {
    const inCost = effInM * t.inPerM;
    const outCost = outM * t.outPerM;
    return { name: t.name, inCost, outCost, total: inCost + outCost };
  });
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  const barsEl = document.getElementById("bars");
  barsEl.replaceChildren();
  rows.forEach((r) => {
    const box = document.createElement("div"); box.className = "tier";
    const top = document.createElement("div"); top.className = "tier-top";
    const l = document.createElement("span"); l.textContent = r.name;
    const rt = document.createElement("span"); rt.textContent = fmtUsd(r.total) + " / mo";
    top.append(l, rt);
    const track = document.createElement("div"); track.className = "bar-bg";
    const bi = document.createElement("div"); bi.className = "bar-in"; bi.style.width = ((r.inCost / maxTotal) * 100).toFixed(1) + "%";
    const bo = document.createElement("div"); bo.className = "bar-out"; bo.style.width = ((r.outCost / maxTotal) * 100).toFixed(1) + "%";
    track.append(bi, bo);
    box.append(top, track);
    barsEl.append(box);
  });
  return rows;
}

Object.values(els).forEach((el) => el.addEventListener("input", compute));
document.querySelectorAll(".preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".preset").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const p = PRESETS[btn.dataset.preset];
    Object.entries(p).forEach(([k, v]) => { els[k].value = String(v); });
    compute();
  });
});

document.getElementById("copy-md").addEventListener("click", (e) => {
  const rows = compute();
  const md = rows.map((r) => "- " + r.name + ": " + fmtUsd(r.total) + "/mo").join("\\n");
  try { void navigator.clipboard.writeText(md); } catch {}
  e.target.textContent = "Copied!";
  setTimeout(() => { e.target.textContent = "Copy Summary"; }, 1200);
});

compute();
`;

  return [
    textWriteItem("structure/index.html", html, "text/html"),
    textWriteItem("structure/styles.css", css, "text/css"),
    textWriteItem("structure/app.js", js, "application/javascript"),
  ];
}

function buildCssGlassStudio(title: string): NoteFileWriteItem[] {
  const safe = escapeHtml(title);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="wrap">
    <div class="stage" id="stage">
      <div class="orb orb-1"></div>
      <div class="orb orb-2"></div>
      <div class="orb orb-3"></div>
      <div class="glass-card" id="glass-card">
        <span class="badge">LIVE GLASS SURFACE</span>
        <h2>${safe}</h2>
        <p>Tweak blur, transparency, border tint, and surface radius — then copy production-ready CSS.</p>
      </div>
    </div>

    <aside class="inspector">
      <label>Blur <strong id="v-blur">18px</strong><input id="blur" type="range" min="0" max="40" value="18" /></label>
      <label>Fill Opacity <strong id="v-alpha">0.18</strong><input id="alpha" type="range" min="2" max="70" value="18" /></label>
      <label>Saturation <strong id="v-sat">160%</strong><input id="sat" type="range" min="100" max="240" value="160" /></label>
      <label>Corner Radius <strong id="v-rad">20px</strong><input id="rad" type="range" min="4" max="36" value="20" /></label>
      <pre class="code" id="css-out"></pre>
      <button type="button" class="copy" id="copy-css">Copy CSS</button>
    </aside>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const css = `* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #101216; color: #f4f4f5; font-family: ui-sans-serif, -apple-system, sans-serif; padding: 20px; display: flex; }
.wrap { flex: 1; display: grid; grid-template-columns: 1.2fr 300px; gap: 16px; max-width: 980px; margin: 0 auto; }
@media (max-width: 720px) { .wrap { grid-template-columns: 1fr; } }
.stage {
  position: relative; min-height: 360px; border-radius: 18px; overflow: hidden;
  background: linear-gradient(135deg, #161822, #101b18); display: grid; place-items: center; padding: 28px;
}
.orb { position: absolute; border-radius: 999px; filter: blur(36px); animation: float 8s ease-in-out infinite alternate; }
.orb-1 { width: 220px; height: 220px; background: #6366f1; top: 14%; left: 16%; }
.orb-2 { width: 200px; height: 200px; background: #10b981; bottom: 12%; right: 18%; animation-delay: -3s; }
.orb-3 { width: 150px; height: 150px; background: #f59e0b; top: 45%; right: 32%; animation-delay: -5s; }
@keyframes float { from { transform: translate(0, 0) scale(1); } to { transform: translate(22px, -18px) scale(1.12); } }
.glass-card { position: relative; z-index: 2; max-width: 360px; padding: 24px; color: #ffffff; }
.glass-card h2 { margin: 10px 0 8px; font-size: 20px; }
.glass-card p { margin: 0; font-size: 13px; line-height: 1.5; opacity: 0.88; }
.badge { font-family: ui-monospace, monospace; font-size: 10px; letter-spacing: 0.12em; padding: 3px 8px; border-radius: 999px; background: rgba(255,255,255,0.16); }
.inspector { background: #181a20; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.inspector label { display: grid; grid-template-columns: 1fr auto; gap: 5px; font-size: 12px; color: #a1a1aa; }
.inspector input { grid-column: 1 / -1; accent-color: #34d399; }
.code { margin: 0; padding: 10px; border-radius: 10px; background: #0d0f13; font-family: ui-monospace, monospace; font-size: 11px; color: #a7f3d0; white-space: pre-wrap; }
.copy { border: none; border-radius: 10px; background: #34d399; color: #052e16; font-weight: 700; padding: 9px; cursor: pointer; }
`;

  const js = `const card = document.getElementById("glass-card");
const out = document.getElementById("css-out");
const blur = document.getElementById("blur");
const alpha = document.getElementById("alpha");
const sat = document.getElementById("sat");
const rad = document.getElementById("rad");

function update() {
  const b = blur.value + "px";
  const a = (Number(alpha.value) / 100).toFixed(2);
  const s = sat.value + "%";
  const r = rad.value + "px";
  document.getElementById("v-blur").textContent = b;
  document.getElementById("v-alpha").textContent = a;
  document.getElementById("v-sat").textContent = s;
  document.getElementById("v-rad").textContent = r;

  card.style.background = "rgba(255, 255, 255, " + a + ")";
  card.style.backdropFilter = "blur(" + b + ") saturate(" + s + ")";
  card.style.webkitBackdropFilter = card.style.backdropFilter;
  card.style.borderRadius = r;
  card.style.border = "1px solid rgba(255, 255, 255, 0.24)";
  card.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.32)";

  out.textContent = [
    "background: rgba(255, 255, 255, " + a + ");",
    "backdrop-filter: blur(" + b + ") saturate(" + s + ");",
    "border: 1px solid rgba(255, 255, 255, 0.24);",
    "border-radius: " + r + ";",
  ].join("\\n");
}

[blur, alpha, sat, rad].forEach((i) => i.addEventListener("input", update));
document.getElementById("copy-css").addEventListener("click", (e) => {
  try { void navigator.clipboard.writeText(out.textContent); } catch {}
  e.target.textContent = "Copied CSS!";
  setTimeout(() => { e.target.textContent = "Copy CSS"; }, 1100);
});

update();
`;

  return [
    textWriteItem("structure/index.html", html, "text/html"),
    textWriteItem("structure/styles.css", css, "text/css"),
    textWriteItem("structure/app.js", js, "application/javascript"),
  ];
}

function buildDeskKanban(title: string): NoteFileWriteItem[] {
  const safe = escapeHtml(title);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="board-app">
    <header class="top">
      <div>
        <h1>${safe}</h1>
        <div class="progress-wrap">
          <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
          <span id="progress-label">0%</span>
        </div>
      </div>
      <form class="add-form" id="add-form">
        <input id="new-title" type="text" placeholder="Quick add card..." maxlength="64" />
        <select id="new-prio">
          <option value="high">High</option>
          <option value="normal" selected>Normal</option>
          <option value="quick">Quick</option>
        </select>
        <button type="submit">Add</button>
      </form>
    </header>

    <div class="cols" id="cols"></div>
  </div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const css = `:root { --bg: #fcfcfb; --side: #f3f2ed; --ink: #1c1917; --muted: #706a61; --line: #e4e1d8; --accent: #4d7a2a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, -apple-system, sans-serif; padding: 18px; }
.board-app { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
h1 { margin: 0; font-size: 18px; }
.progress-wrap { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.progress-bar { width: 150px; height: 7px; border-radius: 999px; background: var(--line); overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); width: 0%; transition: width .2s ease; }
.add-form { display: flex; gap: 6px; }
input, select { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 10px; font-size: 12px; }
button { border: 1px solid var(--line); background: var(--accent); color: #fff; border-radius: 8px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
.cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 700px) { .cols { grid-template-columns: 1fr; } }
.col { background: var(--side); border: 1px solid var(--line); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 280px; }
.col-head { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: var(--muted); }
.card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.card-title { font-size: 13px; font-weight: 500; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.tag { font-family: ui-monospace, monospace; font-size: 10px; padding: 2px 6px; border-radius: 6px; background: var(--side); color: var(--muted); }
.tag.high { background: #fee2e2; color: #b91c1c; }
.tag.quick { background: #dcfce7; color: #166534; }
.actions { display: flex; gap: 4px; }
.mini { background: var(--side); color: var(--ink); border: 1px solid var(--line); padding: 2px 7px; font-size: 11px; border-radius: 6px; }
`;

  const js = `const COLS = [
  { id: "today", label: "Today" },
  { id: "doing", label: "In Flow" },
  { id: "done", label: "Done" },
];

const store = (() => {
  const mem = new Map();
  return {
    get(k, fb) { try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : fb; } catch { return mem.has(k) ? mem.get(k) : fb; } },
    set(k, v) { mem.set(k, v); try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
})();

let cards = store.get("vv-desk-kanban", [
  { id: "1", title: "Review open pull request feedback", col: "today", prio: "high" },
  { id: "2", title: "Prototype standalone HTML desk app", col: "doing", prio: "normal" },
  { id: "3", title: "Verify dark mode contrast tokens", col: "done", prio: "quick" },
]);

function render() {
  const done = cards.filter((c) => c.col === "done").length;
  const pct = cards.length ? Math.round((done / cards.length) * 100) : 0;
  document.getElementById("progress-fill").style.width = pct + "%";
  document.getElementById("progress-label").textContent = pct + "% (" + done + "/" + cards.length + ")";

  const colsEl = document.getElementById("cols");
  colsEl.replaceChildren();
  COLS.forEach((col, cIdx) => {
    const colCards = cards.filter((c) => c.col === col.id);
    const wrap = document.createElement("div"); wrap.className = "col";
    const head = document.createElement("div"); head.className = "col-head";
    head.innerHTML = "<span>" + col.label + "</span><span>" + colCards.length + "</span>";
    wrap.append(head);

    colCards.forEach((item) => {
      const card = document.createElement("div"); card.className = "card";
      const t = document.createElement("div"); t.className = "card-title"; t.textContent = item.title;
      const foot = document.createElement("div"); foot.className = "card-foot";
      const tag = document.createElement("span"); tag.className = "tag " + item.prio; tag.textContent = item.prio;
      const acts = document.createElement("div"); acts.className = "actions";
      if (cIdx > 0) {
        const b = document.createElement("button"); b.type = "button"; b.className = "mini"; b.textContent = "←";
        b.addEventListener("click", () => { item.col = COLS[cIdx - 1].id; store.set("vv-desk-kanban", cards); render(); });
        acts.append(b);
      }
      if (cIdx < COLS.length - 1) {
        const b = document.createElement("button"); b.type = "button"; b.className = "mini"; b.textContent = "→";
        b.addEventListener("click", () => { item.col = COLS[cIdx + 1].id; store.set("vv-desk-kanban", cards); render(); });
        acts.append(b);
      }
      const del = document.createElement("button"); del.type = "button"; del.className = "mini"; del.textContent = "×";
      del.addEventListener("click", () => { cards = cards.filter((c) => c.id !== item.id); store.set("vv-desk-kanban", cards); render(); });
      acts.append(del);
      foot.append(tag, acts);
      card.append(t, foot);
      wrap.append(card);
    });
    colsEl.append(wrap);
  });
}

document.getElementById("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("new-title");
  const title = input.value.trim();
  if (!title) return;
  cards.unshift({ id: String(Date.now()), title, col: "today", prio: document.getElementById("new-prio").value });
  input.value = "";
  store.set("vv-desk-kanban", cards);
  render();
});

render();
`;

  return [
    textWriteItem("structure/index.html", html, "text/html"),
    textWriteItem("structure/styles.css", css, "text/css"),
    textWriteItem("structure/app.js", js, "application/javascript"),
  ];
}

export function buildAppSeedFiles(seed: AppTemplateSeed, title: string): NoteFileWriteItem[] {
  const appFiles = (() => {
    switch (seed) {
      case "protoFocusStudio":
        return buildFocusStudio(title);
      case "protoSynthPad":
        return buildSynthPad(title);
      case "protoParticleLab":
        return buildParticleLab(title);
      case "protoTokenCalculator":
        return buildTokenCalculator(title);
      case "protoCssGlassStudio":
        return buildCssGlassStudio(title);
      case "protoDeskKanban":
        return buildDeskKanban(title);
    }
  })();
  return [
    {
      path: "structure/doc.json",
      mime: "application/json",
      encoding: "utf8",
      content: `${JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "b1", type: "heading", level: 1, text: title },
            { id: "b2", type: "preview", entry: "structure/index.html", height: 540, title },
          ],
        },
        null,
        2,
      )}\n`,
    },
    ...appFiles,
  ];
}
