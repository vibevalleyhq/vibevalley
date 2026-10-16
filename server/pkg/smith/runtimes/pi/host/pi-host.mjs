// OAR's pi host: pi's own SDK, opened the way the TS package opens it
// (packages/oar/src/runtimes/pi/open.ts, session.ts, mcp.ts, credentials.ts,
// lifecycle.ts, list-models.ts, inventory.ts), driven by the Go port over
// newline-delimited JSON on stdio. pi is a Node program, so this host adds
// no runtime the user does not already have; it loads the SDK of the pi the
// user installed (the package root is argv[2]).
//
// Wire (pi's RPC mode family): the first stdin line is the job,
//   {"type":"open"|"models"|"inventory", ...}
// answered by one {"type":"response","id":...}. A session then takes
// commands ({"id","type":"prompt"|"steer"|"abort"|"dispose", ...}) and
// emits every SDK event as one line, plus OAR's own lines:
//   oar_context      pi's context fullness, just before agent_settled
//   oar_overflow     pi-ai's isContextOverflow held for the next event
//   oar_credential   a provider key pi resolved, for OAR's redactor only
//   oar_prompt_rejected  a started run pi failed without settling it
//   oar_abort_rejected   pi refused an abort
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (root === undefined) {
  process.stderr.write("usage: pi-host.mjs <pi-coding-agent package root>\n");
  process.exit(2);
}

const write = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};
const respond = (id, data) => write({ type: "response", id, success: true, ...(data === undefined ? {} : { data }) });
const refuse = (id, error, details = {}) => write({ type: "response", id, success: false, error: error instanceof Error ? error.message : String(error), ...details });

/** A package's export path, resolved from its directory as its exports map names it. */
function packageEntry(directory, subpath = ".") {
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  const entry = manifest.exports?.[subpath];
  const target = typeof entry === "string" ? entry : entry?.import ?? entry?.default;
  if (target === undefined) {
    throw new Error(`${manifest.name} exports no ${subpath}`);
  }
  return pathToFileURL(path.join(directory, target)).href;
}

/** Where a dependency of the pi package lives: beside it (pnpm), in its node_modules, or a parent's. */
function dependencyDir(name) {
  const candidates = [path.join(path.dirname(root), name.split("/")[1])];
  for (let directory = root; ; directory = path.dirname(directory)) {
    candidates.push(path.join(directory, "node_modules", name));
    if (path.dirname(directory) === directory) {
      break;
    }
  }
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")) && JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8")).name === name);
  if (found === undefined) {
    throw new Error(`cannot find ${name} beside ${root}`);
  }
  return found;
}

const sdk = await import(packageEntry(root));
const piAiDir = dependencyDir("@earendil-works/pi-ai");
const piAi = await import(packageEntry(piAiDir));
const { getSupportedThinkingLevels } = await import(packageEntry(piAiDir, "./models"));
const httpDispatcher = await import(pathToFileURL(path.join(root, "dist", "core", "http-dispatcher.js")).href).catch(() => null);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done) {
  process.exit(0);
}
const job = JSON.parse(first.value);

/** pi's process-wide setup, as its CLI makes it: the proxy plane and the theme. */
function preparePi(settingsManager) {
  if (httpDispatcher !== null) {
    httpDispatcher.applyHttpProxySettings?.(settingsManager.getGlobalSettings().httpProxy);
    httpDispatcher.configureHttpDispatcher?.(settingsManager.getHttpIdleTimeoutMs());
  }
  sdk.initTheme?.(settingsManager.getTheme(), false);
}

/** resolve.ts piSessionDir: <agentDir>/sessions/--<cwd slug>--. */
function piSessionDir(cwd, agentDir) {
  const slug = path.resolve(cwd).replace(/^[/\\]/u, "").replaceAll(/[/\\:]/gu, "-");
  return path.join(path.resolve(agentDir), "sessions", `--${slug}--`);
}

/** environment.ts: a child environment with the session's overlay (null removes). */
function sessionEnvironment(overlay, inherited) {
  const env = { ...inherited };
  for (const [name, value] of Object.entries(overlay ?? {})) {
    for (const key of Object.keys(env)) {
      if (process.platform === "win32" ? key.toUpperCase() === name.toUpperCase() : key === name) {
        delete env[key];
      }
    }
    if (value !== null) {
      env[name] = value;
    }
  }
  return env;
}

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { oarCode: code, ...extra });

async function openSession(open) {
  const { cwd, agentDir, resume, model, thinkingLevel, systemPrompt, appendSystemPrompt, env, disallowedTools, name, mcpServers } = open;
  // YOLO by default: pre-trust the session cwd as pi's own Trust button would.
  new sdk.ProjectTrustStore(agentDir).set(cwd, true);
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  preparePi(settingsManager);
  const rememberKey = (key) => {
    if (typeof key === "string" && key.length > 0) {
      write({ type: "oar_credential", key });
    }
  };
  const rememberPiKey = async (registry, selected) => {
    if (selected === undefined) {
      return;
    }
    const auth = await registry.getApiKeyAndHeaders(selected);
    if (auth.ok) {
      rememberKey(auth.apiKey);
    }
  };
  // mcp.ts: pi's MCP extension with no mcp.json of its own, and one registering the session's servers.
  const failures = [];
  const extensionFactories = [];
  if (mcpServers !== undefined && mcpServers.length > 0) {
    extensionFactories.push(
      { name: "oar-mcp", factory: sdk.createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: path.join(agentDir, "mcp.log") }), hidden: true },
      { name: "oar-mcp-servers", factory: (pi) => {
        for (const [serverName, config] of mcpServers) {
          try {
            pi.registerMcpServer(serverName, config);
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
      }, hidden: true },
    );
  }
  extensionFactories.push({ name: "oar-credentials", factory: (pi) => {
    pi.on("model_select", async (event, context) => { await rememberPiKey(context.modelRegistry, event.model); });
  }, hidden: true });
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [appendSystemPrompt] }),
      extensionFactories,
    },
  });
  const ours = new Set(["<inline:oar-mcp>", "<inline:oar-mcp-servers>"]);
  failures.push(...services.resourceLoader.getExtensions().errors.filter((entry) => ours.has(entry.path)).map((entry) => entry.error));
  if (failures.length > 0) {
    throw failure("error", `pi did not register the session's MCP servers: ${failures.join("; ")}`);
  }
  const sessionDir = piSessionDir(cwd, agentDir);
  let sessionManager;
  if (resume === undefined) {
    sessionManager = sdk.SessionManager.create(cwd, sessionDir);
  } else {
    const sessions = await sdk.SessionManager.list(cwd, sessionDir);
    const found = sessions.find((session) => session.id === resume);
    if (found === undefined) {
      throw failure("session_not_found",
        `pi session ${resume} not found: no session file with that id under ${sessionDir} (${String(sessions.length)} session(s) there for cwd ${cwd}; pi persists a session on its first message)`,
        { native: { cwd, sessionDir, sessionCount: sessions.length } });
    }
    sessionManager = sdk.SessionManager.open(found.path, sessionDir);
  }
  let resolvedModel;
  if (model !== undefined) {
    const slash = model.indexOf("/");
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    resolvedModel = services.modelRuntime.getModel(provider, modelId);
    if (resolvedModel === undefined) {
      throw failure("model_unavailable", `pi model ${model} is not registered: provider ${provider} has no model ${modelId} (see \`oar models pi\` for the usable list)`);
    }
  }
  const customTools = env === undefined ? undefined : [sdk.defineTool(sdk.createBashToolDefinition(cwd, {
    spawnHook: (context) => ({ ...context, env: sessionEnvironment(env, context.env) }),
  }))];
  const { session } = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    ...(disallowedTools === undefined ? {} : { excludeTools: [...disallowedTools] }),
    ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(customTools === undefined ? {} : { customTools }),
  });
  const effective = session.model === undefined ? null : `${session.model.provider}/${session.model.id}`;
  if (model !== undefined && effective !== model) {
    session.dispose();
    throw failure("error", `pi did not apply model ${model}: the session reports ${effective ?? "no model"}`);
  }
  if (thinkingLevel !== undefined && session.thinkingLevel !== thinkingLevel) {
    const reported = `pi runs thinking level ${session.thinkingLevel} for ${effective ?? "no model"} although ${thinkingLevel} was requested (the model offers ${session.getAvailableThinkingLevels().join(", ")})`;
    session.dispose();
    throw failure("error", reported);
  }
  if (name !== undefined && !sessionManager.getEntries().some((entry) => entry.type === "session_info")) {
    sessionManager.appendSessionInfo(name);
  }
  try {
    await rememberPiKey(new sdk.ModelRegistry(session.modelRuntime), session.model);
    await session.bindExtensions({});
  } catch (error) {
    await disposeSession(session);
    throw error;
  }
  return { session, effective };
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** lifecycle.ts: extension shutdown while its context is live, bounded, then dispose. */
async function disposeSession(session) {
  let timer;
  try {
    const deadline = new Promise((resolve) => { timer = setTimeout(() => { resolve(false); }, SHUTDOWN_TIMEOUT_MS); });
    const completed = await Promise.race([session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).then(() => true), deadline]);
    if (!completed) {
      process.emitWarning(
        `pi session_shutdown hooks timed out after ${String(SHUTDOWN_TIMEOUT_MS)} ms for session ${session.sessionId}; releasing the session without waiting for remaining hooks`,
        { code: "OAR_PI_SHUTDOWN_TIMEOUT" },
      );
    }
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
}

function overflowOf(event) {
  if (event.type === "turn_end") {
    return event.message.role === "assistant" && event.message.stopReason === "error" && piAi.isContextOverflow(event.message);
  }
  return event.type === "message_update" && event.assistantMessageEvent.type === "error" && piAi.isContextOverflow(event.assistantMessageEvent.error);
}

async function runSession(open) {
  let opened;
  try {
    opened = await openSession(open);
  } catch (error) {
    refuse(job.id, error, { code: error.oarCode ?? "error", ...(error.native === undefined ? {} : { native: error.native }) });
    process.exit(0);
  }
  const { session, effective } = opened;
  respond(job.id, { sessionId: session.sessionId, model: effective, thinkingLevel: session.thinkingLevel });
  const startWaiters = new Set();
  session.subscribe((event) => {
    if (event.type === "agent_start") {
      for (const waiter of startWaiters) {
        waiter();
      }
    }
    if (event.type === "agent_settled") {
      const usage = session.getContextUsage();
      if (usage !== undefined) {
        write({ type: "oar_context", usage: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } });
      }
    } else if (overflowOf(event)) {
      write({ type: "oar_overflow" });
    }
    write(event);
  });
  const images = (list) => (list === undefined || list.length === 0 ? undefined : list);
  let disposing = false;
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    const line = next.value;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    const { id } = command;
    switch (command.type) {
      case "prompt": {
        // session.ts start(): accepted once pi starts the run, refused with pi's own words before that.
        let onStarted;
        const started = new Promise((resolve) => { onStarted = resolve; });
        startWaiters.add(onStarted);
        const run = session.prompt(command.message, images(command.images) === undefined ? undefined : { images: command.images });
        void Promise.race([started.then(() => "started"), run.then(() => "started", (error) => error)]).then((decided) => {
          startWaiters.delete(onStarted);
          if (decided === "started") {
            respond(id);
            run.catch((error) => { write({ type: "oar_prompt_rejected", message: error instanceof Error ? error.message : "pi prompt failed" }); });
          } else {
            refuse(id, decided instanceof Error ? decided : "pi prompt failed");
          }
        });
        break;
      }
      case "steer":
        session.steer(command.message, images(command.images)).then(() => { respond(id); }, (error) => { refuse(id, error); });
        break;
      case "abort":
        session.abort().then(() => { respond(id); }, (error) => {
          write({ type: "oar_abort_rejected", message: error instanceof Error ? error.message : String(error) });
          refuse(id, error);
        });
        break;
      case "dispose":
        if (!disposing) {
          disposing = true;
          if (session.isStreaming) {
            await session.abort().catch(() => {});
          }
          await disposeSession(session);
          respond(id);
          process.exit(0);
        }
        break;
      default:
        refuse(id, `unknown command ${String(command.type)}`);
    }
  }
  // stdin ended without a dispose: release the session all the same.
  if (!disposing) {
    await disposeSession(session);
  }
  process.exit(0);
}

/** list-models.ts and model-projection.ts. */
async function listModels({ cwd, agentDir, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs ?? 15_000);
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  preparePi(settingsManager);
  const services = await sdk.createAgentSessionServices({
    cwd, agentDir, settingsManager, modelRuntimeSignal: signal,
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const runtime = services.modelRuntime;
  const available = await runtime.getAvailable(undefined, { signal });
  const provider = settingsManager.getDefaultProvider();
  const savedId = settingsManager.getDefaultModel();
  return available.map((model) => {
    const effortLevels = model.reasoning === true ? getSupportedThinkingLevels(model) : [];
    const providerName = runtime.getProvider?.(model.provider)?.name?.trim();
    const isDefault = provider !== undefined && savedId !== undefined && provider === model.provider && savedId === model.id;
    return {
      id: `${model.provider}/${model.id}`,
      displayName: model.name === undefined || model.name.trim().length === 0 ? model.id : model.name.trim(),
      ...(effortLevels.length === 0 ? {} : { effortLevels: [...effortLevels] }),
      provider: { id: model.provider, ...(providerName === undefined || providerName.length === 0 || providerName === model.provider ? {} : { displayName: providerName }) },
      ...(isDefault ? { default: true } : {}),
    };
  });
}

/** inventory.ts: an in-memory session's skills, commands and tools; no trust-store write, no model prompt. */
async function inventory({ cwd, agentDir, what }) {
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  sdk.initTheme?.(settingsManager.getTheme(), false);
  const services = await sdk.createAgentSessionServices({ cwd, agentDir, settingsManager });
  const { session } = await sdk.createAgentSessionFromServices({ services, sessionManager: sdk.SessionManager.inMemory(cwd) });
  try {
    if (what === "skills") {
      const result = session.resourceLoader.getSkills();
      return { view: "discovered", partial: result.diagnostics.length > 0, items: result.skills.map((skill) => ({
        name: skill.name, description: skill.description, path: skill.filePath,
        disableModelInvocation: skill.disableModelInvocation, source: skill.sourceInfo.source,
      })) };
    }
    if (what === "commands") {
      const runner = session.extensionRunner;
      const result = session.resourceLoader.getPrompts();
      const items = [
        ...runner.getRegisteredCommands().map((command) => ({ name: command.invocationName, source: "extension", ...(command.description === undefined ? {} : { description: command.description }) })),
        ...result.prompts.map((template) => ({ name: template.name, description: template.description, source: "prompt", ...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }) })),
      ];
      const partial = result.diagnostics.length > 0 || session.resourceLoader.getExtensions().errors.length > 0 || runner.getCommandDiagnostics().length > 0;
      return { view: "discovered", partial, items };
    }
    const active = new Set(session.getActiveToolNames());
    return { view: "registered", partial: false, items: session.getAllTools().map((tool) => ({
      name: tool.name, description: tool.description, active: active.has(tool.name),
      ...(tool.parameters !== null && typeof tool.parameters === "object" && !Array.isArray(tool.parameters) ? { inputSchema: tool.parameters } : {}),
    })) };
  } finally {
    session.dispose();
  }
}

try {
  switch (job.type) {
    case "open":
      await runSession(job);
      break;
    case "models":
      respond(job.id, { models: await listModels(job) });
      process.exit(0);
      break;
    case "inventory":
      respond(job.id, await inventory(job));
      process.exit(0);
      break;
    default:
      refuse(job.id, `unknown job ${String(job.type)}`);
      process.exit(0);
  }
} catch (error) {
  refuse(job.id, error);
  process.exit(0);
}
