/** Where the agent says what went wrong that it carries on without: the host's logger (the server's Logger fits), or the
 * console when it runs on its own. */
export interface AgentLog {
  readonly debug: (...message: readonly unknown[]) => void;
  readonly warn: (...message: readonly unknown[]) => void;
  readonly error: (...message: readonly unknown[]) => void;
}

export const consoleLog: AgentLog = {
  // Below the level a standalone agent says.
  debug: () => undefined,
  // oxlint-disable-next-line no-console -- the standalone agent has no logger but the console
  warn: (...message) => console.warn(...message),
  // oxlint-disable-next-line no-console -- the standalone agent has no logger but the console
  error: (...message) => console.error(...message),
};
