import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import '../ui/px.dart';
import '../data/remote.dart' show agentsProvider;
import '../voice/voice.dart';
import 'calls.dart';
import 'lcd.dart';
import 'widgets.dart';
import '../rules/view.dart';
import 'bug_snake_game.dart';
import 'merge_game.dart';
import '../shared/looks.dart';

enum PhoneApp { home, missed, log, blocks, dino, sokoban, bugs, merge }

const _cream = Color(0xFFF7E8C4);
const _bark = Color(0xFF2F1F13);
const _answer = Color(0xFF5A8234);
const _decline = Color(0xFFC84A3A);

BoxDecoration _paleBox([Color fill = Lcd.pale]) => BoxDecoration(
  color: fill,
  border: Border.all(color: Lcd.dark, width: 2),
);

class PhoneGlyph extends StatelessWidget {
  const PhoneGlyph({super.key, required this.size, this.lit = false});
  final double size;
  final bool lit;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size * 10 / 16,
    height: size,
    child: CustomPaint(painter: _CellsPainter(phoneCells(lit), const Size(10, 16))),
  );
}

List<(int, int, int, int, Color)> phoneCells(bool lit) => [
  (1, 0, 8, 16, const Color(0xFF2F1F13)),
  (2, 1, 6, 14, const Color(0xFF67482D)),
  (3, 2, 4, 5, lit ? const Color(0xFFB4E07A) : const Color(0xFF9FB07A)),
  (3, 9, 1, 1, const Color(0xFFE2C995)),
  (5, 9, 1, 1, const Color(0xFFE2C995)),
  (3, 11, 1, 1, const Color(0xFFE2C995)),
  (5, 11, 1, 1, const Color(0xFFE2C995)),
  (3, 13, 3, 1, const Color(0xFFE2C995)),
  (8, 1, 1, 3, const Color(0xFF2F1F13)),
  if (lit) (9, 0, 1, 1, const Color(0xFFC84A3A)),
];

class _CellsPainter extends CustomPainter {
  _CellsPainter(this.cells, this.grid, {this.origin = Offset.zero});
  final List<(num, num, num, num, Color)> cells;
  final Size grid;
  final Offset origin;

  @override
  void paint(Canvas canvas, Size size) {
    final k = math.min(size.width / grid.width, size.height / grid.height);
    canvas
      ..translate((size.width - grid.width * k) / 2, (size.height - grid.height * k) / 2)
      ..scale(k)
      ..translate(-origin.dx, -origin.dy);
    final p = Paint()..isAntiAlias = false;
    for (final (x, y, w, h, c) in cells) {
      canvas.drawRect(Rect.fromLTWH(x.toDouble(), y.toDouble(), w.toDouble(), h.toDouble()), p..color = c);
    }
  }

  @override
  bool shouldRepaint(_CellsPainter old) => old.cells != cells;
}

class CallerFace extends ConsumerWidget {
  const CallerFace({super.key, required this.call, required this.size});
  final InboxItem call;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox.square(dimension: size);
    return switch (call.from) {
      InboxFromWorker(:final id, :final agent) => AnimalFace(
        atlas: atlas,
        look: lookOf((ref.watch(agentsProvider).value ?? const {})[agent], agent.isEmpty ? id : agent, atlas.has),
        size: size,
      ),
      InboxFromManager() => ManagerFace(atlas: atlas, size: size),
    };
  }
}

class _Manager extends ConsumerWidget {
  const _Manager(this.size);
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    return atlas == null ? SizedBox.square(dimension: size) : ManagerFace(atlas: atlas, size: size);
  }
}

Widget _bigFace(Widget face) => Container(width: 72, height: 72, decoration: _paleBox(), alignment: Alignment.center, child: face);

Widget _smallFace(Widget face) => Container(
  width: 32,
  height: 32,
  color: Lcd.pale,
  alignment: Alignment.center,
  child: ClipRect(child: face),
);

class RingingScreen extends StatelessWidget {
  const RingingScreen({super.key, required this.call, required this.onAnswer, required this.onDecline});
  final InboxItem call;
  final VoidCallback onAnswer;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 20, 12, 0),
    child: Column(
      children: [
        Blink(child: Text('来电…', style: lcdText())),
        const SizedBox(height: 12),
        Shake(child: _bigFace(CallerFace(call: call, size: 60))),
        const SizedBox(height: 12),
        Text(callerName(call), style: lcdText(size: 24, height: 1)),
        const SizedBox(height: 8),
        Container(
          color: Lcd.dark,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          child: Text(inboxKindLabel(call.kind), style: lcdText(color: Lcd.pale)),
        ),
        const SizedBox(height: 8),
        Flexible(
          child: Text(call.text, maxLines: 3, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: lcdText(height: 1.625)),
        ),
        const Spacer(),
        Padding(
          padding: const EdgeInsets.only(bottom: 20),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              RoundKey(answer: false, label: '挂断', onTap: onDecline),
              const SizedBox(width: 32),
              RoundKey(answer: true, label: '接听', onTap: onAnswer),
            ],
          ),
        ),
      ],
    ),
  );
}

class RoundKey extends StatelessWidget {
  const RoundKey({super.key, required this.answer, required this.label, required this.onTap});
  final bool answer;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Hover(
    onTap: onTap,
    label: label,
    builder: (_) => Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 44,
          height: 44,
          child: CustomPaint(
            painter: _KeyPainter(answer ? _answer : _decline),
            child: Center(
              child: Transform.rotate(
                angle: answer ? 0 : 135 * math.pi / 180,
                child: SizedBox(
                  width: 22,
                  height: 12,
                  child: CustomPaint(painter: _CellsPainter(const [(0, 2, 3, 4, _cream), (8, 2, 3, 4, _cream), (1, 0, 9, 2, _cream)], const Size(11, 6))),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(label, style: lcdText()),
      ],
    ),
  );
}

class _KeyPainter extends CustomPainter {
  _KeyPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final p = Paint()..isAntiAlias = false;
    canvas
      ..drawRect(Offset.zero & size, p..color = color)
      ..drawRect(Rect.fromLTWH(0, h - 3, w, 3), p..color = const Color(0x40000000))
      ..drawRect(Rect.fromLTWH(w - 3, 0, 3, h - 3), p);
    p.color = _bark;
    canvas
      ..drawRect(Rect.fromLTWH(0, 0, w, 2), p)
      ..drawRect(Rect.fromLTWH(0, h - 2, w, 2), p)
      ..drawRect(Rect.fromLTWH(0, 0, 2, h), p)
      ..drawRect(Rect.fromLTWH(w - 2, 0, 2, h), p);
  }

  @override
  bool shouldRepaint(_KeyPainter old) => old.color != color;
}

String duration(Duration d) {
  final s = math.max(0, (d.inMilliseconds / 1000).round());
  return '${s ~/ 60}:${'${s % 60}'.padLeft(2, '0')}';
}

class ListScreen extends ConsumerWidget {
  const ListScreen({super.key, required this.screen, required this.onScreen, required this.onAnswer, required this.onCall});
  final PhoneApp screen;
  final ValueChanged<PhoneApp> onScreen;
  final ValueChanged<InboxItem> onAnswer;
  final VoidCallback onCall;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final phone = ref.watch(phoneProvider);
    final missed = phone.missed;
    final log = phone.log;
    Widget empty(String text) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 24),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: lcdText(color: Lcd.dark),
      ),
    );
    Widget row(List<Widget> children) => Container(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Lcd.rule)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(children: children),
    );
    final List<Widget> items = screen == PhoneApp.missed
        ? missed.isEmpty
              ? [empty('没有未接来电。地里都好好的。')]
              : [
                  for (final c in missed)
                    Hover(
                      onTap: () => onAnswer(c),
                      label: '${callerName(c)}：${inboxKindLabel(c.kind)}',
                      builder: (over) => ColoredBox(
                        color: over ? Lcd.light : const Color(0x00000000),
                        child: row([
                          _smallFace(CallerFace(call: c, size: 28)),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Text(callerName(c), style: lcdText()),
                                    const Spacer(),
                                    Text(inboxKindLabel(c.kind), style: lcdText(color: _decline)),
                                  ],
                                ),
                                Text(
                                  c.text,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: lcdText(color: Lcd.dark),
                                ),
                              ],
                            ),
                          ),
                        ]),
                      ),
                    ),
                ]
        : log.isEmpty
        ? [empty('还没有通话。')]
        : [
            for (final e in log)
              switch (e) {
                PhoneLogVoice(:final from, :final to) => row([
                  _smallFace(const _Manager(28)),
                  const SizedBox(width: 8),
                  Expanded(child: Text('打给管家', style: lcdText())),
                  Text(duration(to.difference(from)), style: lcdText(color: Lcd.dark)),
                ]),
                PhoneLogCall(:final call, :final answered) => row([
                  _smallFace(CallerFace(call: call, size: 28)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text('${callerName(call)} · ${inboxKindLabel(call.kind)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: lcdText()),
                  ),
                  Text(answered ? '接了' : '挂了', style: lcdText(color: answered ? Lcd.dark : _decline)),
                ]),
              },
          ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: Lcd.dark, width: 2)),
          ),
          child: Row(
            children: [
              for (final s in const [PhoneApp.missed, PhoneApp.log])
                Expanded(
                  child: Hover(
                    onTap: () => onScreen(s),
                    builder: (over) => Container(
                      color: screen == s ? Lcd.dark : (over ? Lcd.light : const Color(0x00000000)),
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      alignment: Alignment.center,
                      child: Text(s == PhoneApp.missed ? '未接 ${missed.length}' : '记录', style: lcdText(color: screen == s ? Lcd.pale : Lcd.ink)),
                    ),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: ListView(padding: EdgeInsets.zero, children: items),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Hover(
            onTap: onCall,
            label: '打给管家',
            builder: (over) => Container(
              padding: const EdgeInsets.symmetric(vertical: 6),
              decoration: BoxDecoration(
                color: over ? const Color(0xFF638C3A) : _answer,
                border: Border.all(color: _bark, width: 2),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const PhoneGlyph(size: 14, lit: true),
                  const SizedBox(width: 8),
                  Text('打给管家', style: lcdText(color: _cream)),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

const _mood = {'idle': '在等你说', 'listening': '在听', 'thinking': '在想', 'speaking': '在说', 'silent': '没说话'};

class VoiceScreen extends StatefulWidget {
  const VoiceScreen({super.key, required this.call});
  final VoiceCall call;

  @override
  State<VoiceScreen> createState() => _VoiceScreenState();
}

class _VoiceScreenState extends State<VoiceScreen> {
  final _from = DateTime.now();
  late DateTime _now = _from;
  late final Timer _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _now = DateTime.now()));

  @override
  void initState() {
    super.initState();
    _tick;
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.call,
    builder: (context, _) {
      final v = widget.call;
      final last = v.captions.turns.lastOrNull;
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 16, 12, 0),
        child: Column(
          children: [
            Text(v.phase == CallPhase.connecting ? '在接通…' : '通话中 ${duration(_now.difference(_from))}', style: lcdText()),
            const SizedBox(height: 12),
            _bigFace(const _Manager(60)),
            const SizedBox(height: 8),
            Text('管家', style: lcdText(size: 24, height: 1)),
            const SizedBox(height: 4),
            Text(v.agentHere ? (_mood[v.agentState ?? 'idle'] ?? _mood['idle']!) : '还没进来', style: lcdText()),
            const SizedBox(height: 12),
            _Meter('你', v.micLevel / 255),
            const SizedBox(height: 4),
            _Meter('他', v.managerLevel / 255),
            if (last != null && last.text.isNotEmpty) ...[
              const SizedBox(height: 12),
              Flexible(
                child: Container(
                  width: double.infinity,
                  color: Lcd.pale,
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Text(last.text, maxLines: 3, overflow: TextOverflow.ellipsis, style: lcdText(height: 1.625)),
                ),
              ),
            ],
            const Spacer(),
            Padding(
              padding: const EdgeInsets.only(bottom: 20),
              child: RoundKey(answer: false, label: '挂断', onTap: v.end),
            ),
          ],
        ),
      );
    },
  );
}

class _Meter extends StatelessWidget {
  const _Meter(this.label, this.level);
  final String label;
  final double level;

  @override
  Widget build(BuildContext context) {
    final lit = (math.min(1.0, level * 1.6) * 10).round();
    return Row(
      children: [
        SizedBox(width: 16, child: Text(label, style: lcdText())),
        for (var i = 0; i < 10; i++) ...[const SizedBox(width: 4), Expanded(child: Container(height: 8, color: i < lit ? Lcd.dark : Lcd.light))],
      ],
    );
  }
}

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key, required this.missed, required this.onOpen, required this.onCall, required this.onChannels, required this.onPlans});
  final int missed;
  final ValueChanged<PhoneApp> onOpen;
  final VoidCallback onCall;
  final VoidCallback onChannels;
  final VoidCallback onPlans;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    Widget sprite(String name) => atlas == null || !atlas.has(name) ? const SizedBox.square(dimension: 28) : _Sprite(atlas[name], 28);
    final apps = <(String, Widget, int, VoidCallback)>[
      ('未接', PhoneGlyph(size: 26, lit: missed > 0), missed, () => onOpen(PhoneApp.missed)),
      ('记录', sprite('icon-log'), 0, () => onOpen(PhoneApp.log)),
      ('管家', const _Manager(28), 0, onCall),
      ('频道', sprite('icon-board'), 0, onChannels),
      ('计划', sprite('icon-plan'), 0, onPlans),
      ('方块', const _BlocksIcon(), 0, () => onOpen(PhoneApp.blocks)),
      (
        '推箱子',
        Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(border: Border.all(color: Lcd.ink, width: 2)),
          alignment: Alignment.center,
          child: Text('×', style: lcdText(size: 18, height: 1)),
        ),
        0,
        () => onOpen(PhoneApp.sokoban),
      ),
      ('小恐龙', const _DinoIcon(), 0, () => onOpen(PhoneApp.dino)),
      ('贪吃虫', const BugSnakeIcon(), 0, () => onOpen(PhoneApp.bugs)),
      ('种田 2048', const MergeIcon(), 0, () => onOpen(PhoneApp.merge)),
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 16, 8, 0),
      child: Wrap(
        runSpacing: 12,
        children: [
          for (final (label, icon, badge, go) in apps)
            FractionallySizedBox(
              widthFactor: 1 / 3,
              child: Hover(
                onTap: go,
                label: label,
                builder: (over) => Column(
                  children: [
                    SizedBox(
                      width: 44,
                      height: 44,
                      child: Stack(
                        clipBehavior: Clip.none,
                        children: [
                          Positioned.fill(
                            child: Container(decoration: _paleBox(over ? Lcd.paleHover : Lcd.pale), alignment: Alignment.center, child: icon),
                          ),
                          if (badge > 0)
                            Positioned(
                              top: -6,
                              right: -6,
                              child: Container(
                                color: _decline,
                                padding: const EdgeInsets.symmetric(horizontal: 4),
                                child: Text(
                                  '$badge',
                                  style: lcdText(color: _cream, height: 14 / 12),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(label, style: lcdText()),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _Sprite extends StatelessWidget {
  const _Sprite(this.sprite, this.size);
  final SpriteInfo sprite;
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: size,
    child: Image.asset(sprite.asset, fit: BoxFit.contain, filterQuality: FilterQuality.none, isAntiAlias: false),
  );
}

class _BlocksIcon extends StatelessWidget {
  const _BlocksIcon();

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 28,
    child: CustomPaint(
      painter: _CellsPainter(const [
        (0, 5, 7, 2, Lcd.dark),
        (1, 4, 2, 1, Lcd.dark),
        (2, 1, 3, 1, Lcd.ink),
        (3, 2, 1, 1, Lcd.ink),
        (5, 4, 1, 1, Lcd.mid),
        (4, 5, 1, 1, Lcd.paper),
      ], const Size(7, 7)),
    ),
  );
}

class _DinoIcon extends StatelessWidget {
  const _DinoIcon();

  static const _rows = ['  ####', ' ## ##', ' #####', ' ##   ', '####  ', '##### ', ' ###  ', ' # #  '];
  static final _cells = <(num, num, num, num, Color)>[
    for (var y = 0; y < _rows.length; y++)
      for (var x = 0; x < _rows[y].length; x++)
        if (_rows[y][x] == '#') (x, y, 1, 1, Lcd.ink),
    (-1, 8, 8, 1, Lcd.dark),
  ];

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 28,
    child: CustomPaint(painter: _CellsPainter(_cells, const Size(8, 10), origin: const Offset(-1, -1))),
  );
}
