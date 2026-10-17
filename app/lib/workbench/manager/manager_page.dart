import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/prefs.dart';
import '../../ui/kit/kit.dart';
import '../../shared/faces.dart';
import '../shared/memory_panels.dart';
import '../shared/widgets.dart';
import '../../shared/work_log.dart';
import '../voice/voice_page.dart';
import '../../data/providers.dart';
import '../../gen/vibevalley.dart' show managerAgent, ManagerEvalRequest;
import '../../rules/cast.dart';

const _tabs = [('memory', '记性'), ('trajectory', '轨迹'), ('archive', '旧账'), ('voice', '声音')];

class ManagerPage extends ConsumerStatefulWidget {
  const ManagerPage({super.key, this.tab});

  /// memory (the default), trajectory, archive or voice.
  final String? tab;

  @override
  ConsumerState<ManagerPage> createState() => _ManagerPageState();
}

class _ManagerPageState extends ConsumerState<ManagerPage> {
  late String _at = _valid(widget.tab);

  static String _valid(String? tab) => _tabs.any((t) => t.$1 == tab) ? tab! : 'memory';

  @override
  void didUpdateWidget(ManagerPage old) {
    super.didUpdateWidget(old);
    if (old.tab != widget.tab) _at = _valid(widget.tab);
  }

  @override
  Widget build(BuildContext context) {
    final chosen = ref.watch(prefsProvider.select((p) => p.managerLook)) ?? 'farmer';
    final look = managerLooks.where((l) => l.id == chosen).firstOrNull;
    Widget card(Widget child) => PxWindow(padding: const EdgeInsets.all(16), child: child);
    final panel = switch (_at) {
      'trajectory' => card(
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '管家每一轮的经过：它收到的话、调的每个工具（点开看参数和结果）、它说的话。新的在下面，一直留着最近的 1000 步。哪一轮做错了，在它收到的话上点「这一轮做错了」，写一句应该怎样，存成一条评测。',
              style: KitText.xs.copyWith(height: 1.625, color: Palette.bark600),
            ),
            const SizedBox(height: 16),
            TrajectoryLog(
              id: managerAgent,
              asked: '收到',
              empty: '管家还没开过口。',
              onMarkWrong: (step, want) => ref
                  .read(apiProvider)
                  .manager
                  .markWrong(
                    body: ManagerEvalRequest(on: step.toDouble(), want: want),
                  ),
            ),
          ],
        ),
      ),
      'archive' => card(const ArchivePanel()),
      'voice' => const VoiceSettingsForm(part: VoicePart.agent),
      _ => card(const ManagerMemoryPanel()),
    };
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 896),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              PxWindow(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    const WorkbenchManagerFace(size: 72),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          DefaultTextStyle(
                            style: KitText.xs.copyWith(color: Palette.bark500),
                            child: InlineLink('← 全部帮工', color: Palette.bark500, onTap: () => workbenchGo(context, '/agents')),
                          ),
                          const Text('管家', style: KitText.x2l),
                          Text(
                            '管家不下地：听你说要做什么，派帮工去做，盯着进度，转告结果。${look != null ? '长相是${look.name}，在农场的管家面板里换。' : ''}',
                            style: KitText.sm.copyWith(color: Palette.bark600),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              PxWindow(
                padding: const EdgeInsets.all(8),
                child: WorkbenchTabs<String>(
                  value: _at,
                  big: true,
                  tabs: _tabs,
                  onChanged: (t) {
                    setState(() => _at = t);
                    workbenchGo(context, '/manager/$t');
                  },
                ),
              ),
              const SizedBox(height: 12),
              KeyedSubtree(key: ValueKey(_at), child: panel),
            ],
          ),
        ),
      ),
    );
  }
}
