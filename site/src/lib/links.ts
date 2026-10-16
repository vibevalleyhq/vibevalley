// Where the page points: the repository, and the commands that build the app from it.

export const GITHUB = 'https://github.com/vibevalleyhq/vibevalley'

export const COMMANDS = [
  'git clone https://github.com/vibevalleyhq/vibevalley.git && cd vibevalley',
  'app/tool/agora-voice-only.sh',
  'bun run package:mac',
  'open app/build/vibevalley.app',
]
