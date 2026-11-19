export const GITHUB = "https://github.com/vibevalleyhq/vibevalley";

const nativeBranch = "refactor/native-macos-cutover";
export const NATIVE_SOURCE = `${GITHUB}/tree/${nativeBranch}`;

export const COMMANDS = [
  `git clone --branch ${nativeBranch} --single-branch ${GITHUB}.git`,
  "cd vibevalley",
  "vp install",
  "vp run nsh:install",
  "vp run package:mac",
  "open apps/mac/dist/VibeValley.app",
];
