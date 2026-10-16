// Keep it in step with protocol/seeds.json.

import '../gen/vibevalley.dart';

const defaultEye = '#a6f4ff';

class RuntimePreset {
  const RuntimePreset(this.id, this.label, this.blurb, this.look);
  final String id;
  final String label;

  final String blurb;
  final Look look;
}

Look _look(Build build, Head head, String body, String trim, String hat) => Look(build: build, head: head, body: body, trim: trim, hat: hat, eye: defaultEye);

final runtimePresets = <RuntimePreset>[
  RuntimePreset('claude', 'Claude Code', 'Anthropic 的命令行编码 agent。', _look(Build.biped, Head.rounded, '#f3e9da', '#d9774f', '#e8804f')),
  RuntimePreset('codex', 'Codex', 'OpenAI 的编码 agent，走 app-server。', _look(Build.treads, Head.terminal, '#3d434a', '#d8dadc', '#f4f3ee')),
  RuntimePreset('opencode', 'opencode', '开源的终端编码 agent，走 ACP。', _look(Build.biped, Head.terminal, '#e9e6de', '#24282d', '#2f3438')),
  RuntimePreset('vibevalley', 'vibevalley', 'VibeValley 自己的 agent（DeepSeek），跑在 server 进程里。', _look(Build.hopper, Head.orb, '#fbe7c6', '#4f9a5a', '#f2b53a')),
  RuntimePreset('pi', 'Pi', '跑在 server 进程里的编码 agent SDK。', _look(Build.hopper, Head.dome, '#f4e6d4', '#b0503f', '#d9534f')),
  RuntimePreset('cursor', 'Cursor', 'Cursor 的 agent SDK，跑在 server 进程里。', _look(Build.wheel, Head.saucer, '#dfe4ea', '#5b6470', '#a9b4c2')),
  RuntimePreset('grok', 'Grok', 'xAI 的 grok CLI，走 ACP。', _look(Build.wheel, Head.dome, '#b9c4d1', '#3a404a', '#4f86d9')),
  RuntimePreset('kimi', 'Kimi', 'Moonshot 的 kimi CLI，走 ACP。', _look(Build.hopper, Head.orb, '#e7e6fb', '#6c70d8', '#9580e6')),
  RuntimePreset('antigravity', 'Antigravity', 'Google 的 Antigravity agent，走 ACP。', _look(Build.hover, Head.saucer, '#d3efe8', '#2f9d8f', '#45bf8c')),
];

final _fallbackLook = _look(Build.biped, Head.rounded, '#f1e8d8', '#5d5850', '#f2b53a');

RuntimePreset presetOf(String runtime) {
  for (final p in runtimePresets) {
    if (p.id == runtime) return p;
  }
  return RuntimePreset(runtime, runtime, 'VibeValley 还没有专属外形的 runtime。', _fallbackLook);
}

/// The id for one without a preset.
String runtimeName(String runtime) => presetOf(runtime).label;
