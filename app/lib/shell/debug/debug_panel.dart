import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../sfx.dart';
import '../synth.dart';
import 'debug_commands.dart';
import 'debug_log.dart';
import '../../rules/clock.dart';

final debugOpenProvider = NotifierProvider<DebugOpen, bool>(DebugOpen.new);

class DebugOpen extends Notifier<bool> {
  @override
  bool build() => false;
  void toggle() => state = !state;
  void set(bool open) => state = open;
}

/// The hotkey leaves it alone then.
bool typing() {
  final context = FocusManager.instance.primaryFocus?.context;
  return context != null && (context.widget is EditableText || context.findAncestorStateOfType<EditableTextState>() != null);
}

bool debugHotkey(KeyEvent e, void Function() toggle) {
  if (e is! KeyDownEvent || e.character != '`' || typing()) return false;
  toggle();
  return true;
}

const _panelBg = Color(0xF514110E);
const _ink850 = Color(0xFF221E1A);
const _hat = Palette.hat;

const _xs = TextStyle(fontFamily: pixelFont, fontSize: 12, height: 4 / 3, color: Palette.ink100);
final _mono = KitText.mono.copyWith(color: Palette.ink100);

class DebugPanel extends ConsumerStatefulWidget {
  const DebugPanel({super.key});

  @override
  ConsumerState<DebugPanel> createState() => _DebugPanelState();
}

enum _Tab { control, sessions, sounds, events }

const _tabLabel = {_Tab.control: '控制', _Tab.sessions: '帮工', _Tab.sounds: '音效', _Tab.events: '事件'};

class _DebugPanelState extends ConsumerState<DebugPanel> {
  _Tab _tab = _Tab.control;

  @override
  Widget build(BuildContext context) {
    if (!ref.watch(debugOpenProvider)) return const SizedBox.shrink();
    final width = MediaQuery.sizeOf(context).width;
    return Align(
      alignment: Alignment.topRight,
      child: SizedBox(
        width: width < 416 ? width : 416,
        child: Semantics(
          container: true,
          label: '调试台',
          child: DecoratedBox(
            decoration: const BoxDecoration(
              color: _panelBg,
              border: Border(left: BorderSide(color: Color(0x1AFFFFFF))),
              boxShadow: kitDrop,
            ),
            child: DefaultTextStyle(
              style: _xs,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _header(),
                  _tabs(),
                  Expanded(
                    child: switch (_tab) {
                      _Tab.control => const _Scroll(child: _ControlTab()),
                      _Tab.sessions => const _Scroll(child: _SessionsTab()),
                      _Tab.sounds => const _Scroll(child: _SoundsTab()),
                      _Tab.events => const _EventsTab(),
                    },
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _header() => Container(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: Color(0x0DFFFFFF))),
    ),
    child: Row(
      children: [
        const Text(
          '调试台',
          style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.paper),
        ),
        const SizedBox(width: 8),
        Container(
          color: Palette.ink800,
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          child: const Text(
            'server',
            style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink300),
          ),
        ),
        const SizedBox(width: 8),
        const Expanded(
          child: Text(
            '按 ` 开关',
            style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
          ),
        ),
        _Btn(label: '关闭 `', onTap: () => ref.read(debugOpenProvider.notifier).set(false)),
      ],
    ),
  );

  Widget _tabs() => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: const BoxDecoration(
      border: Border(bottom: BorderSide(color: Color(0x0DFFFFFF))),
    ),
    child: Wrap(
      spacing: 4,
      children: [
        for (final t in _Tab.values)
          KitTappable(
            onTap: () => setState(() => _tab = t),
            selected: _tab == t,
            semanticLabel: _tabLabel[t],
            builder: (context, state) => Container(
              height: 32,
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              color: _tab == t ? Palette.ink700 : null,
              child: Text(
                _tabLabel[t]!,
                style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: _tab == t ? Palette.paper : (state.hovered ? Palette.ink100 : Palette.ink300)),
              ),
            ),
          ),
      ],
    ),
  );
}

class _Scroll extends StatelessWidget {
  const _Scroll({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(padding: const EdgeInsets.all(16), child: child);
}

class _Section extends StatelessWidget {
  const _Section({required this.title, this.aside, required this.child});
  final String title;
  final String? aside;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(
              title,
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, letterSpacing: 0.6, color: Palette.ink500),
            ),
            const SizedBox(width: 8),
            if (aside != null)
              Expanded(
                child: Text(
                  aside!,
                  textAlign: TextAlign.right,
                  style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        child,
      ],
    ),
  );
}

enum _Tone { plain, hat, bad }

class _Btn extends StatelessWidget {
  const _Btn({required this.label, required this.onTap, this.active = false, this.tone = _Tone.plain});
  final String label;
  final VoidCallback? onTap;
  final bool active;
  final _Tone tone;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    semanticLabel: label,
    builder: (context, state) {
      final (bg, fg) = active
          ? (_hat, Palette.ink950)
          : switch (tone) {
              _Tone.bad => (Palette.bad.withValues(alpha: state.hovered ? 0.25 : 0.15), Palette.bad),
              _Tone.hat => (_hat.withValues(alpha: state.hovered ? 0.25 : 0.15), _hat),
              _Tone.plain => (state.hovered ? Palette.ink700 : Palette.ink800, Palette.ink100),
            };
      return Container(
        height: 28,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: bg,
          border: state.focused ? Border.all(color: _hat, width: 2) : null,
        ),
        child: Text(
          label,
          style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: fg),
        ),
      );
    },
  );
}

class _Row extends StatelessWidget {
  const _Row(this.children);
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: children);
}

class _TextAction extends StatefulWidget {
  const _TextAction({required this.placeholder, required this.action, required this.onSubmit});
  final String placeholder;
  final String action;
  final void Function(String text) onSubmit;

  @override
  State<_TextAction> createState() => _TextActionState();
}

class _TextActionState extends State<_TextAction> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _submit() {
    if (_text.text.trim().isEmpty) return;
    widget.onSubmit(_text.text);
    _text.clear();
  }

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: SizedBox(
          height: 32,
          child: TextField(
            controller: _text,
            onSubmitted: (_) => _submit(),
            style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.paper),
            cursorColor: _hat,
            decoration: InputDecoration(
              hintText: widget.placeholder,
              hintStyle: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
              filled: true,
              fillColor: Palette.ink800,
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.zero,
                borderSide: BorderSide(color: _hat.withValues(alpha: 0.6), width: 2),
              ),
            ),
          ),
        ),
      ),
      const SizedBox(width: 6),
      KitTappable(
        onTap: _submit,
        semanticLabel: widget.action,
        builder: (context, state) => Container(
          height: 32,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          color: state.hovered ? Palette.ink500.withValues(alpha: 0.6) : Palette.ink700,
          child: Text(
            widget.action,
            style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink100),
          ),
        ),
      ),
    ],
  );
}

void _run(BuildContext context, Future<void> Function() command) {
  unawaited(
    command().catchError((Object e) {
      toasts.add(type: ToastType.error, title: '调试台', description: '$e', timeout: const Duration(milliseconds: 4500));
    }),
  );
}

class _ControlTab extends ConsumerStatefulWidget {
  const _ControlTab();

  @override
  ConsumerState<_ControlTab> createState() => _ControlTabState();
}

class _ControlTabState extends ConsumerState<_ControlTab> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // The village's clock is not a provider: look again while the tab is open.
    _tick = Timer.periodic(const Duration(milliseconds: 300), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final hb = ref.watch(hbProvider);
    final farm = ref.watch(stateProvider);
    final view = ref.watch(viewProvider);
    final hooks = ref.watch(debugHooksProvider);
    final game = farm?.progress;
    final level = view?.level;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Section(
          title: '通话',
          aside: '现在：${farm?.call.wire ?? '—'}',
          child: _Row([
            _Btn(label: '开工', tone: _Tone.hat, onTap: () => _run(context, hb.start)),
            _Btn(label: '收工', onTap: () => _run(context, () => hb.everyone('dismiss'))),
          ]),
        ),
        _Section(
          title: '管家',
          aside: farm == null ? null : '${farm.manager.wire} · ${managerLabel[farm.manager]}',
          child: _TextAction(placeholder: '模拟你对管家说…（会走派活规则）', action: '听', onSubmit: (t) => _run(context, () => hb.hear(t))),
        ),
        _Section(
          title: '天色',
          aside: hooks == null ? '农场画面还没接上' : clockText(hooks.tod()),
          child: hooks == null
              ? const Text(
                  '天色是农场画面自己的钟：回到农场再来调。',
                  style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _Slider(label: '时间', value: hooks.tod(), min: 0, max: 0.999, divisions: 200, format: clockText, onChanged: hb.tod),
                    const SizedBox(height: 8),
                    _Row([
                      for (final n in [0.0, 1.0, 10.0, 60.0])
                        _Btn(label: n == 0 ? '停住' : '${n.round()}×', active: hooks.daySpeed() == n, onTap: () => hb.daySpeed(n)),
                      for (final (name, t) in [('清晨', 0.27), ('正午', 0.5), ('傍晚', 0.79), ('深夜', 0.95)]) _Btn(label: name, onTap: () => hb.tod(t)),
                    ]),
                  ],
                ),
        ),
        _Section(
          title: '游戏进度',
          aside: level == null || game == null
              ? null
              : 'Lv.${level.level.round()} · ${farm?.commits?.total.round() ?? 0} commit · ${game.coins.round()} 金币 · 收成 ${(game.counts['harvests'] ?? 0).round()} · 成就 ${game.unlocked.length}',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                '金币、等级和成就是服务端账本折出来的，这里改不了；下面两个只放一遍横幅和提示，什么都不记。',
                style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
              ),
              const SizedBox(height: 8),
              _Row([_Btn(label: '升一级（带横幅）', onTap: hb.levelUp), _Btn(label: '弹一个成就', onTap: () => hb.achieve())]),
            ],
          ),
        ),
      ],
    );
  }
}

class _Slider extends StatelessWidget {
  const _Slider({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.divisions,
    required this.format,
    required this.onChanged,
  });
  final String label;
  final double value;
  final double min;
  final double max;
  final int divisions;
  final String Function(double) format;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      SizedBox(
        width: 96,
        child: Text(
          label,
          style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink300),
        ),
      ),
      Expanded(
        child: SliderTheme(
          data: SliderTheme.of(context).copyWith(activeTrackColor: _hat, thumbColor: _hat, inactiveTrackColor: Palette.ink700, trackHeight: 2),
          child: Slider(value: value.clamp(min, max), min: min, max: max, divisions: divisions, onChanged: onChanged),
        ),
      ),
      SizedBox(
        width: 56,
        child: Text(
          format(value),
          textAlign: TextAlign.right,
          style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink100),
        ),
      ),
    ],
  );
}

class _SessionsTab extends ConsumerWidget {
  const _SessionsTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hb = ref.watch(hbProvider);
    final sessions = ref.watch(stateProvider)?.sessions ?? const <Session>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Section(
          title: '全部',
          aside: '场上 ${sessions.length} 个',
          child: _Row([
            _Btn(label: '全部叫停', onTap: () => _run(context, () => hb.everyone('stop'))),
            _Btn(label: '全部收工', tone: _Tone.bad, onTap: () => _run(context, () => hb.everyone('dismiss'))),
          ]),
        ),
        if (sessions.isEmpty)
          const Text(
            '地里没有帮工。先开工，再对管家说句话。',
            style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
          ),
        for (final h in sessions) ...[_SessionCard(session: h, hb: hb), const SizedBox(height: 8)],
      ],
    );
  }
}

class _SessionCard extends StatelessWidget {
  const _SessionCard({required this.session, required this.hb});
  final Session session;
  final Hb hb;

  @override
  Widget build(BuildContext context) {
    final h = session;
    return Container(
      color: _ink850,
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(
                h.name,
                style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.paper),
              ),
              const SizedBox(width: 6),
              Container(
                color: Palette.ink800,
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Text(
                  phaseLabel(h.phase),
                  style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink300),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${h.id} · ${runtimeLabel[h.runtime] ?? h.runtime} · 第 ${h.runs.round()} 轮',
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
                ),
              ),
              KitTappable(
                onTap: () => hb.open(h.id),
                semanticLabel: '看档案',
                builder: (context, state) => Text(
                  '看档案',
                  style: TextStyle(
                    fontFamily: pixelFont,
                    fontSize: 12,
                    color: _hat,
                    decoration: state.hovered ? TextDecoration.underline : null,
                    decorationColor: _hat,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            h.task,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: _mono.copyWith(color: Palette.ink300),
          ),
          const SizedBox(height: 8),
          _Row([
            if (h.phase is PhaseRipe) _Btn(label: '收获', tone: _Tone.hat, onTap: () => _run(context, () => hb.harvest(h.id))),
            _Btn(label: '叫停', onTap: () => _run(context, () => hb.stop(h.id))),
            _Btn(label: '收工', tone: _Tone.bad, onTap: () => _run(context, () => hb.dismiss(h.id))),
          ]),
          const SizedBox(height: 8),
          _TextAction(placeholder: '给${h.name}带话（能插话就插话，不能就排队）', action: '带话', onSubmit: (t) => _run(context, () => hb.tell(h.id, t))),
        ],
      ),
    );
  }
}

class _SoundsTab extends ConsumerStatefulWidget {
  const _SoundsTab();

  @override
  ConsumerState<_SoundsTab> createState() => _SoundsTabState();
}

class _SoundsTabState extends ConsumerState<_SoundsTab> {
  Map<String, Measure>? _stats;
  bool _measuring = false;

  Future<void> _measure() async {
    setState(() => _measuring = true);
    final stats = await Hb.soundStats();
    if (mounted) {
      setState(() {
        _stats = stats;
        _measuring = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final hb = ref.watch(hbProvider);
    final stats = _stats;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '全部是实时合成的，没有音频文件。配方在 lib/shell/sfx.dart；关了音效就听不到。',
          style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
        ),
        const SizedBox(height: 16),
        for (final group in soundGroups)
          _Section(
            title: group.title,
            child: _Row([for (final name in group.names) _PlayButton(label: soundLabel[name]!, onTap: () => hb.play(name))]),
          ),
        _Section(
          title: '响度',
          aside: '峰值 dBFS · 响度（最响的 100 ms）· 时长',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Row([_Btn(label: _measuring ? '在算……' : '算一遍', onTap: _measuring ? null : () => unawaited(_measure()))]),
              if (stats != null) ...[
                const SizedBox(height: 8),
                for (final MapEntry(key: name, value: m) in stats.entries)
                  Row(
                    children: [
                      SizedBox(
                        width: 96,
                        child: Text(
                          soundLabel[name] ?? name,
                          style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink300),
                        ),
                      ),
                      Expanded(child: Text('${m.peak}  ${m.loudness}  ${m.seconds}s', style: _mono)),
                    ],
                  ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _PlayButton extends ConsumerWidget {
  const _PlayButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final play = ref.watch(atlasProvider).value?['button-play'];
    return KitTappable(
      onTap: onTap,
      semanticLabel: label,
      builder: (context, state) => Container(
        height: 28,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        color: state.hovered ? Palette.ink700 : Palette.ink800,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (play != null) ...[Image.asset(play.asset, width: 12, height: 12, filterQuality: FilterQuality.none), const SizedBox(width: 4)],
            Text(
              label,
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink100),
            ),
          ],
        ),
      ),
    );
  }
}

const _typeTone = {'frame': Color(0xFFB9C6FF), 'step': Palette.ink300, 'notice': Palette.bad, 'runtime': Color(0xFF8FD3C8)};

class _EventsTab extends ConsumerStatefulWidget {
  const _EventsTab();

  @override
  ConsumerState<_EventsTab> createState() => _EventsTabState();
}

class _EventsTabState extends ConsumerState<_EventsTab> {
  final _hidden = <String>{'step'};
  int? _open;
  String _result = '';

  @override
  Widget build(BuildContext context) {
    final log = ref.watch(debugLogProvider);
    final notifier = ref.read(debugLogProvider.notifier);
    final shown = log.entries.where((e) => !_hidden.contains(e.type)).toList().reversed.take(250).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: Color(0x0DFFFFFF))),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _Row([
                for (final t in _typeTone.keys)
                  KitTappable(
                    onTap: () => setState(() => _hidden.contains(t) ? _hidden.remove(t) : _hidden.add(t)),
                    semanticLabel: t,
                    builder: (context, _) => Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      color: _hidden.contains(t) ? _ink850 : Palette.ink800,
                      child: Text(
                        t,
                        style: _mono.copyWith(
                          color: _hidden.contains(t) ? Palette.ink500 : _typeTone[t],
                          decoration: _hidden.contains(t) ? TextDecoration.lineThrough : null,
                          decorationColor: Palette.ink500,
                        ),
                      ),
                    ),
                  ),
              ]),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: _Row([
                      _Btn(label: log.paused ? '已暂停记录' : '暂停记录', active: log.paused, onTap: () => notifier.pause(!log.paused)),
                      _Btn(label: '清空', onTap: notifier.clear),
                      _Btn(
                        label: '复制 .jsonl',
                        onTap: () async {
                          await Clipboard.setData(ClipboardData(text: notifier.export()));
                          if (mounted) setState(() => _result = '复制了 ${log.entries.length} 条');
                        },
                      ),
                      if (_result.isNotEmpty)
                        Text(
                          _result,
                          style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink300),
                        ),
                    ]),
                  ),
                  Text(
                    '共 ${log.entries.length} 条',
                    style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.ink500),
                  ),
                ],
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(8),
            itemCount: shown.length,
            itemBuilder: (context, i) {
              final e = shown[i];
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  KitTappable(
                    onTap: () => setState(() => _open = _open == e.seq ? null : e.seq),
                    semanticLabel: e.summary,
                    builder: (context, state) => Container(
                      color: state.hovered ? const Color(0x0AFFFFFF) : null,
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 40,
                            child: Text('${e.seq}', style: _mono.copyWith(color: Palette.ink500)),
                          ),
                          SizedBox(
                            width: 67,
                            child: Text(e.type, style: _mono.copyWith(color: _typeTone[e.type] ?? Palette.ink300)),
                          ),
                          Expanded(
                            child: Text(e.summary, maxLines: 1, overflow: TextOverflow.ellipsis, style: _mono),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (_open == e.seq)
                    Container(
                      margin: const EdgeInsets.fromLTRB(6, 0, 6, 4),
                      padding: const EdgeInsets.all(8),
                      color: _ink850,
                      child: SelectableText(const JsonEncoder.withIndent('  ').convert(e.json()), style: _mono.copyWith(fontSize: 10, color: Palette.ink300)),
                    ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }
}
