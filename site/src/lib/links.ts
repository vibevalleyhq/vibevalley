// Where the page points: the repository, and the commands that build the app from it.

export const GITHUB = 'https://github.com/vibevalleyhq/vibevalley'

export const COMMANDS = [
  'git clone https://github.com/vibevalleyhq/vibevalley.git && cd vibevalley',
  'bun install',
  'bun run package:mac',
  'open apps/desktop/dist/mac-arm64/VibeValley.app',
]
