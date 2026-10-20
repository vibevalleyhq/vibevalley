// What the work log shows for each step, as words and colours: the farm's WorkLog (shared/work_log.dart), the workbench's
// (workbench/shared/work_log.dart) and the trajectories read them.

import 'dart:convert';
import 'dart:ui' show Color;

import '../gen/vibevalley.dart';
import '../rules/rounds.dart';
import '../ui/theme.dart';

String spanLabel(SessionEvent step) => switch (step.type) {
  SessionEventType.userMessage => '收到',
  SessionEventType.memoryRecalled => '想起',
  SessionEventType.assistantThinking => '思考',
  SessionEventType.assistantMessage => '说',
  SessionEventType.llmRetry => '重试',
  SessionEventType.llmUsage => '缓存',
  SessionEventType.runError => '出错',
  SessionEventType.runStart || SessionEventType.runEnd || SessionEventType.toolResult => '',
  SessionEventType.toolCall => farmToolText(step.text) != null ? '田头' : step.actionText ?? '工具',
};

Color spanColor(SessionEvent step) => switch (step.type) {
  SessionEventType.userMessage => Palette.wheat,
  SessionEventType.memoryRecalled => Palette.leaf300,
  SessionEventType.assistantThinking => Palette.cream300,
  SessionEventType.assistantMessage => Palette.leaf500,
  SessionEventType.llmRetry || SessionEventType.llmUsage => Palette.wheatHover,
  SessionEventType.runError => Palette.berry,
  SessionEventType.runStart || SessionEventType.runEnd || SessionEventType.toolResult => Palette.cream200,
  SessionEventType.toolCall when step.ok == false => Palette.berry,
  SessionEventType.toolCall => switch (step.action ?? ToolAction.other) {
    ToolAction.readFile || ToolAction.search || ToolAction.web => Palette.water,
    ToolAction.editFile => Palette.leaf700,
    ToolAction.runCommand => Palette.bark600,
    ToolAction.wait => Palette.cream200,
    ToolAction.mcp || ToolAction.other => Palette.bark400,
  },
};

String? farmToolText(String text) => switch (RegExp(r'^vibevalley__(channel_say|channel_read|channel_inbox|session_list)').firstMatch(text.trim())?.group(1)) {
  'channel_say' => '在田头说话',
  'channel_read' => '读田头的消息',
  'channel_inbox' => '看有没有找它的话',
  'session_list' => '看田头上都有谁',
  null => null,
  final other => '田头：$other',
};

String readableInput(SessionEvent step) {
  final raw = step.input?.trim() ?? '';
  if (raw.isEmpty) return '';
  try {
    final parsed = jsonDecode(raw);
    if (parsed is Map) {
      if (parsed['command'] is String) return '\$ ${parsed['command']}';
      return const JsonEncoder.withIndent('  ').convert(parsed);
    }
    if (parsed is List) return const JsonEncoder.withIndent('  ').convert(parsed);
  } on FormatException {
    // Not JSON (or clipped): show it as it came.
  }
  return raw;
}

/// What started a round, as its fold says it: the first word is the issue, later ones are words carried to it.
String roundLabel(Round round, {required double? firstAsked, String? asked}) {
  final a = round.asked;
  if (a == null) return '更早的步骤';
  if (a.under != null) return '帮手接到';
  return asked ?? (a.seq == firstAsked ? '工单' : '带话');
}

/// Folded to `lines` when longer.
bool isLongText(String text, int lines) => text.length > lines * 60 || text.split('\n').length > lines;

/// The line under a message for the run behind it, or null when there is none to show: a manager's run is shown only when it used tools.
String? turnLabel(List<SessionEvent> steps, {required bool manager}) {
  final tools = steps.where((s) => s.type == SessionEventType.toolCall).length;
  if (steps.isEmpty || (manager && tools == 0)) return null;
  return tools > 0 ? '用了 $tools 个工具' : '这一轮的干活过程';
}
