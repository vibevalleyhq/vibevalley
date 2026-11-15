import { browserConfig, suitesFor } from "./test/projects";

export default browserConfig(suitesFor(process.env.VIBEVALLEY_WEB_SUITE));
