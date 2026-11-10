import { Effect, Formatter, Schema } from "effect";

import type { MossTransport } from "@vibevalley/provider/moss/server";
import { mossVisionModels } from "@vibevalley/provider/moss/vision-models";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      action: Schema.optionalKey(Schema.String),
      type: Schema.optionalKey(Schema.String),
      seq_no: Schema.optionalKey(Schema.Int),
      timestamp: Schema.optionalKey(Schema.Finite),
      run_id: Schema.optionalKey(Schema.String),
      turn_id: Schema.optionalKey(Schema.String),
      final: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

export const realtimeFixture: MossTransport = {
  connect: (_key, on, model) => {
    const visual = mossVisionModels.some((id) => id === model);
    let closed = false;
    let answered = false;
    let camera = false;
    let screen = false;
    let frameSequence = 0;
    let frameTimestamp = 0;
    let promptPending = false;
    let responseSequence = 0;
    const emit = (event: object) => {
      if (!closed) on.text(Formatter.formatJson(event));
    };
    const liveAnswer = (run: string, turn: string, text: string) => {
      emit({ action: "response.audio.started", data: { run_id: run, turn_id: turn } });
      emit({ action: "response.audio.context", data: { run_id: run, turn_id: turn, chunk_id: `${run}-chunk` } });
      on.binary?.(new Uint8Array(9600));
      emit({ action: "response.audio.done", data: { run_id: run, turn_id: turn } });
      emit({ action: "output.transcript.done", data: { run_id: run, turn_id: turn, text } });
    };
    const visualAnswer = () => {
      const response_id = `visual-${responseSequence}`;
      emit({ type: "response.text.delta", response_id, response_seq: responseSequence, turn_id: responseSequence, delta: "Virtual " });
      emit({ type: "response.text.delta", response_id, response_seq: responseSequence, turn_id: responseSequence, delta: "camera frame received." });
      emit({ type: "response.done", response_id, response_seq: responseSequence, turn_id: responseSequence, finish_reason: "stop", boundary: "turn" });
      responseSequence++;
      promptPending = false;
    };
    queueMicrotask(() => {
      if (closed) return;
      on.open();
      if (visual)
        emit({
          type: "session.created",
          session_id: "visual-fixture",
          task_id: "visual-task",
          model,
          turn_id: 0,
          configure_timeout_s: 10,
          protocol_version: "1",
          capabilities: {},
        });
    });
    return {
      bufferedAmount: () => 0,
      close: () => {
        closed = true;
      },
      send: (frame) => {
        if (closed) return;
        if (typeof frame !== "string") {
          if (visual) {
            emit({
              type: "input.frame.accepted",
              seq_no: frameSequence,
              timestamp: frameTimestamp,
              final: false,
              pending_events: 1,
              interrupts_current_turn: false,
            });
            emit({ type: "input.frame.processed", seq_no: frameSequence, timestamp: frameTimestamp, final: false, pending_events: 0 });
            if (promptPending) visualAnswer();
          } else if (frame[0] === 0 && !answered) {
            answered = true;
            liveAnswer("fixture-run", "fixture-turn", "Realtime fixture answer.");
          } else if ((frame[0] === 1 && !camera) || (frame[0] === 2 && !screen)) {
            camera ||= frame[0] === 1;
            screen ||= frame[0] === 2;
            liveAnswer(`fixture-video-run-${frame[0]}`, `fixture-video-${frame[0]}`, "Virtual camera frame received.");
          }
          return;
        }
        const decoded = decode(frame);
        if (decoded._tag === "None") throw new Error("Invalid realtime fixture control frame");
        const event = decoded.value;
        switch (event.action ?? event.type) {
          case "attach_session":
            emit({ action: "session_attached", data: { session_id: "live-fixture", memory_scope: "session", delegation: "none" } });
            break;
          case "session.update":
            emit({ action: "session.updated", data: { error: "" } });
            break;
          case "playback.completed":
            if (event.run_id !== undefined && event.turn_id !== undefined)
              emit({ action: "response.ended", data: { run_id: event.run_id, turn_id: event.turn_id, status: "completed" } });
            break;
          case "session.configure":
            emit({
              type: "session.configured",
              session_id: "visual-fixture",
              request_id: "fixture-request",
              max_frame_bytes: 262144,
              input_queue_capacity: 1,
              max_tokens_per_turn: 32,
              parked_request_timeout_s: 10,
              context_limit: 32768,
            });
            emit({ type: "session.ready", session_id: "visual-fixture", request_id: "fixture-request", turn_id: 0 });
            break;
          case "input.frame":
            frameSequence = event.seq_no ?? 0;
            frameTimestamp = event.timestamp ?? 0;
            emit({ type: "input.frame.ready", seq_no: frameSequence });
            break;
          case "input.prompt":
            emit({ type: "input.prompt.accepted", seq_no: event.seq_no, final: event.final ?? false, pending_events: 1, interrupts_current_turn: true });
            promptPending = true;
            if (event.final === true) {
              visualAnswer();
              emit({
                type: "session.done",
                reason: "completed",
                usage: {
                  vision_tokens: 10,
                  text_input_tokens: 4,
                  text_output_tokens: 6,
                  text_tokens: 10,
                  total_tokens: 20,
                },
              });
            }
            break;
          case "session.abort":
            emit({ type: "session.done", reason: "aborted" });
            break;
          default:
            break;
        }
      },
    };
  },
  status: () => Effect.succeed({ code: 400, body: "" }),
};
