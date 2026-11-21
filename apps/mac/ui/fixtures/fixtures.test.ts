// Prints workbench.ts as the JSON vibevalley_bridge::fake reads; vv/fixtures/write.sh
// saves it to vv/fixtures/workbench/ for VIBEVALLEY_FAKE_SERVER=ui/vv/fixtures/workbench.
import "../infra/polyfill";
import { expect, test } from "nsh/test";

import { responses, state } from "./workbench";

test("workbench fixture as JSON", () => {
  expect(state.state.issues.length).toBe(7);
  console.log(`@@state.json ${JSON.stringify(state)}`);
  console.log(`@@responses.json ${JSON.stringify(responses)}`);
});
