export {
  captureVdpPngFile,
  captureVdpScreenshot,
  createWsVdpDriver,
  discoverVdpEndpoint,
  ensureUiBundlesBuilt,
  ensureVdpArtifactsBuilt,
  isReviewTheme,
  normalizeExplicitVdpUrl,
  parsePositiveInt,
  resolveVdpCargoBuildArgs,
  resolveVdpWorkspacePaths,
  REVIEW_THEMES,
  ShellStateSchema,
  UpdateStateSchema,
  VdpWsClient,
  waitForVdpEndpoint,
  withVdpWsSandbox,
  type ReviewTheme,
  type VdpDriver,
} from "./client.ts";
export { defineScenario, runScenarios, VdpScenarioContext, writeScenarioArtifacts, type VdpRpcTransport, type VdpScenario } from "./dsl.ts";
export { renderScenarioGalleryHtml } from "./gallery.ts";
export { flattenLayoutDump, type VdpUiBounds } from "./layout.ts";
export { playAgentCanvasSession, playAgentDocSession } from "./play.ts";
