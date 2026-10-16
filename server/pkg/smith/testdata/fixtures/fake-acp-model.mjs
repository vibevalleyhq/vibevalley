/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-return, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- Standalone untyped fixture module for fake-acp-agent.mjs. */
// The model the fixture "really" runs, regardless of what was requested: the
// silent-fallback shape both real agents have (grok falls back to the default
// when the requested model is not allowed; kimi keeps its own current id).
// Reported in both upstream spellings: kimi's configOptions row and grok's
// models.currentModelId.
const EFFECTIVE_MODEL = "fixture-model-x";

function modelOption(currentValue) {
  return {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue,
    options: [
      { value: EFFECTIVE_MODEL, name: "Fixture X" },
      { value: "requested-y", name: "Requested Y" },
    ],
  };
}

// The fixture's reasoning-effort selector, in ACP's `thought_level` category
// under an id of its own (grok says `reasoning_effort`, kimi `thinking`): the
// category is what oar looks for, never the id.
const EFFORT_ID = "fixture_effort";
const EFFORT_LEVELS = ["low", "medium", "high"];

function effortOption(currentValue) {
  return {
    type: "select",
    id: EFFORT_ID,
    name: "Effort",
    category: "thought_level",
    currentValue,
    options: EFFORT_LEVELS.map((value) => ({ value, name: value })),
  };
}

/**
 * `mode` "no-thought-level": an agent that offers no effort selector at all.
 * Mode "antigravity" replays agy_acp_server 1.2.1, whose effort is part of the model id.
 */
export function modelReport(mode) {
  // "opencode": the open model has no variants, so no effort selector (opencode/big-pickle).
  const effort = mode !== "no-thought-level" && mode !== "antigravity" && mode !== "opencode";
  return {
    configOptions: [modelOption(EFFECTIVE_MODEL), ...(effort ? [effortOption("medium")] : [])],
    models: {
      currentModelId: EFFECTIVE_MODEL,
      availableModels: [
        { modelId: EFFECTIVE_MODEL, name: "Fixture X" },
        { modelId: "requested-y", name: "Requested Y" },
      ],
    },
  };
}

function pushedModel(currentValue) {
  return { sessionUpdate: "config_option_update", configOptions: [modelOption(currentValue)] };
}

/**
 * What `session/set_model <modelId>` does. `grok-meta`: the applied model
 * rides in the response `_meta` (xai-grok-shell). `kimi-push`: a
 * config_option_update is emitted BEFORE the request is answered, and the
 * answer itself is empty (kimi-code). Anything else: accepted with an empty
 * answer while the fixture keeps running EFFECTIVE_MODEL.
 */
export function setModelResponse(modelId) {
  if (modelId === "grok-meta") {
    return { response: { _meta: { model: "grok-applied" } } };
  }
  if (modelId === "kimi-push") {
    return { pushedUpdate: pushedModel("kimi-pushed"), response: {} };
  }
  if (modelId === "switch-to-z") {
    return { pushedUpdate: pushedModel("fixture-model-z"), response: {} };
  }
  return { response: {} };
}

/**
 * What `session/set_config_option {configId: "model", value}` does, the way
 * agy_acp_server 1.2.1 answers it: a known model is applied and answered with
 * the model option, no `config_option_update` is pushed, and there is no
 * effort selector to report. An unknown model is refused `-32602`. In mode
 * "opencode" (1.18.30) `requested-y` has variants, so the answer also lists
 * the effort selector the open model lacked.
 */
function setModelOption(value, mode) {
  if (value !== EFFECTIVE_MODEL && value !== "requested-y") {
    return { error: { code: -32_602, message: "Invalid params", data: `unknown model ${String(value)}` } };
  }
  const effort = mode === "opencode" && value === "requested-y" ? [effortOption("medium")] : [];
  return { response: { configOptions: [modelOption(value), ...effort] } };
}

/**
 * What `session/set_config_option {configId, value}` does to the effort
 * selector, the way grok 1.0.41 / kimi 2.0.0 answer: a known level is applied,
 * pushed as a `config_option_update` (kimi pushes before answering) and
 * answered with every option's current value; an unknown one is refused
 * `-32602 Invalid params`. `sticky` is a level the fixture accepts but does
 * not apply (answered at `medium`), the silent substitution oar must refuse.
 */
export function setConfigOption(params, mode) {
  if (params?.configId === "model") {
    return setModelOption(params.value, mode);
  }
  if (params?.configId !== EFFORT_ID) {
    return { error: { code: -32_602, message: "Invalid params", data: `unknown config option ${String(params?.configId)}` } };
  }
  if (params.value === "sticky") {
    return { response: { configOptions: [modelOption(EFFECTIVE_MODEL), effortOption("medium")] } };
  }
  if (!EFFORT_LEVELS.includes(params.value)) {
    return { error: { code: -32_602, message: "Invalid params", data: `unknown ${EFFORT_ID} value` } };
  }
  const configOptions = [modelOption(EFFECTIVE_MODEL), effortOption(params.value)];
  return { pushedUpdate: { sessionUpdate: "config_option_update", configOptions }, response: { configOptions } };
}

/**
 * Answer `session/set_model` or `session/set_config_option` on the wire:
 * any push first (kimi pushes before it answers), then the answer, or the
 * refusal as a JSON-RPC error.
 */
export function answerConfigRequest(message, wire, mode) {
  const outcome = message.method === "session/set_model"
    ? setModelResponse(message.params?.modelId)
    : setConfigOption(message.params, mode);
  if (outcome.error !== undefined) {
    wire.error(message.id, outcome.error.code, outcome.error.message, outcome.error.data);
    return;
  }
  if (outcome.pushedUpdate !== undefined) {
    wire.update(outcome.pushedUpdate);
  }
  wire.result(message.id, outcome.response);
}
