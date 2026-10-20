import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/prefs.dart';
import '../../ui/pro/pro.dart';
import '../../shared/faces.dart';
import '../shared/memory_panels.dart';
import '../shared/widgets.dart';
import '../shared/trajectory.dart';
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
    final panel = switch (_at) {
      'trajectory' => TrajectoryLog(
        id: managerAgent,
        asked: '收到',
        empty: '管家还没开过口。',
        leading: const TrajectoryTitle('管家每一轮的经过', about: '它收到的话、调的每个工具（点一行看参数和结果）、它说的话。新的在下面，一直留着最近的 1000 步。哪一轮做错了，在它收到的话上点「这一轮做错了」，写一句应该怎样，存成一条评测。'),
        onMarkWrong: (step, want) => ref
            .read(apiProvider)
            .manager
            .markWrong(
              body: ManagerEvalRequest(on: step.toDouble(), want: want),
            ),
      ),
      'archive' => const ArchivePanel(),
      'voice' => const VoiceSettingsForm(part: VoicePart.agent),
      _ => const ManagerMemoryPanel(),
    };
    final head = Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Row(
        children: [
          Container(
            width: 72,
            height: 72,
            alignment: Alignment.center,
            decoration: const BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(8))),
            child: const WorkbenchManagerFace(size: 64),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DefaultTextStyle(
                  style: ProText.meta,
                  child: InlineLink('← 全部帮工', color: ProColor.muted, onTap: () => workbenchGo(context, '/agents')),
                ),
                const SizedBox(height: 2),
                const Text('管家', style: ProText.x2l),
                const SizedBox(height: 2),
                Text('管家不下地：听你说要做什么，派帮工去做，盯着进度，转告结果。${look != null ? '长相是${look.name}，在农场的管家面板里换。' : ''}', style: ProText.sm.copyWith(color: ProColor.muted)),
              ],
            ),
          ),
        ],
      ),
    );
    final tabs = Container(
      padding: const EdgeInsets.only(bottom: 8),
      decoration: const BoxDecoration(border: Border(bottom: proLine)),
      child: WorkbenchTabs<String>(
        value: _at,
        big: true,
        tabs: _tabs,
        onChanged: (t) {
          setState(() => _at = t);
          workbenchGo(context, '/manager/$t');
        },
      ),
    );
    // The trajectory takes the whole content area, its rows scrolling under a fixed head; the other tabs are a column.
    if (_at == 'trajectory') {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            head,
            const SizedBox(height: 16),
            tabs,
            const SizedBox(height: 16),
            Expanded(
              child: KeyedSubtree(key: ValueKey(_at), child: panel),
            ),
          ],
        ),
      );
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 896),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              head,
              const SizedBox(height: 16),
              tabs,
              const SizedBox(height: 16),
              KeyedSubtree(key: ValueKey(_at), child: panel),
            ],
          ),
        ),
      ),
    );
  }
}
