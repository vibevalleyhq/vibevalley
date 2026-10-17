// At screen pixels, so the words stay sharp. Words let clicks through to the village; the HUD's parts are buttons.

import 'package:flutter/material.dart' hide Icon;
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../rules/warehouse.dart' show harvestedOf;
import '../data/providers.dart';
import '../data/ui_state.dart';
import '../chat/chat_state.dart' show chatOpenProvider, spokenProvider;
import '../farm/friends.dart';
import '../farm/quota.dart';
import '../game/farm.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../phone/phone.dart';
import '../data/prefs.dart';
import '../audio/sfx.dart';
import '../ui/kit/markdown.dart' show plainText;
import '../ui/pixel_card.dart';
import '../voice/voice.dart';
import 'game.dart';
import 'world.dart' show plotH, spotNames;
import '../rules/chat.dart';
import '../rules/clock.dart';
import '../rules/farm.dart';

const hudEdge = 8.0;
const hudGap = 4.0;

const hudTop = 52.0;
const hudBottom = 36.0;

const _rail = 5.0;

const _signGap = 3.0;
const _topEdge = 20.0;
const _signInside = 30.0;

const _speechMs = 9000;

const _tone = {
  BadgeTone.ripe: (CardColors.ripe, CardColors.ink),
  BadgeTone.bug: (CardColors.bug, CardColors.lightInk),
  BadgeTone.stuck: (CardColors.stuck, CardColors.lightInk),
  BadgeTone.rest: (CardColors.rest, CardColors.ink),
};

const _sign = {
  'shop': 'icon-shop',
  'warehouse': 'icon-crate',
  'tasks': 'icon-tasks',
  'log': 'icon-log',
  'plans': 'icon-plan',
  'agents': 'icon-board',
  'runtimes': 'machine-tractor',
  'skills': 'icon-skillbook',
};

class _Pin extends StatelessWidget {
  const _Pin(this.x, this.y, this.child, {this.ay = 1});
  final double x;
  final double y;
  final double ay;
  final Widget child;

  @override
  Widget build(BuildContext context) => Positioned(
    left: x.roundToDouble(),
    top: y.roundToDouble(),
    child: FractionalTranslation(translation: Offset(-0.5, -ay), child: child),
  );
}

/// The village may tick while the screen is being laid out (its first resize), so a tick then waits for the end of that frame.
class FramesBuilder extends StatefulWidget {
  const FramesBuilder({super.key, required this.game, required this.builder});
  final VillageGame game;
  final WidgetBuilder builder;

  @override
  State<FramesBuilder> createState() => _FramesBuilderState();
}

class _FramesBuilderState extends State<FramesBuilder> {
  var _waiting = false;

  @override
  void initState() {
    super.initState();
    widget.game.frames.addListener(_tick);
  }

  @override
  void didUpdateWidget(FramesBuilder old) {
    super.didUpdateWidget(old);
    if (old.game != widget.game) {
      old.game.frames.removeListener(_tick);
      widget.game.frames.addListener(_tick);
    }
  }

  @override
  void dispose() {
    widget.game.frames.removeListener(_tick);
    super.dispose();
  }

  void _tick() {
    if (!mounted || _waiting) return;
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      _waiting = true;
      SchedulerBinding.instance.addPostFrameCallback((_) {
        _waiting = false;
        if (mounted) setState(() {});
      });
    } else {
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) => widget.builder(context);
}

typedef PlotWords = ({String at, PixelCard card});

String plotTitle(Bed bed, Session? session, Crop crop) {
  if (bed.unlockLevel != null) return crop == Crop.locked ? '没开垦的地' : '花坛';
  if (session == null) return '第 ${bed.station + 1} 块地 · 空地';
  return '${session.name} · ${cropLabel[crop]}';
}

({String key, String text, bool final_, double at})? lastManagerSaid(Chat? chat, List<Line> lines) {
  final general = generalOf(chat);
  final typed = general == null ? null : messagesIn(chat, general.id).where((m) => m.fromKind == SenderKind.manager && m.kind == MessageKind.chat).lastOrNull;
  final aloud = lines.where((l) => l.role == LineRole.manager).lastOrNull;
  final a = typed == null ? null : (key: 'm${typed.id}', text: typed.text, final_: typed.final_, at: typed.at);
  final b = aloud == null ? null : (key: 's${aloud.id}', text: aloud.text, final_: aloud.final_, at: aloud.at);
  if (a == null) return b;
  if (b == null) return a;
  return a.at >= b.at ? a : b;
}

class VillageOverlay extends ConsumerStatefulWidget {
  const VillageOverlay({super.key, required this.game, required this.scale});
  final VillageGame game;
  final double scale;

  @override
  ConsumerState<VillageOverlay> createState() => _VillageOverlayState();
}

class _VillageOverlayState extends ConsumerState<VillageOverlay> {
  String? _heardKey;
  double? _finalAt;

  @override
  Widget build(BuildContext context) {
    final game = widget.game;
    return IgnorePointer(
      child: FramesBuilder(
        game: game,
        builder: (context) => Stack(clipBehavior: Clip.none, children: _children(game)),
      ),
    );
  }

  List<Widget> _children(VillageGame game) {
    final s = widget.scale;
    final village = game.village;
    final atlas = game.atlas;
    final state = ref.watch(stateProvider);
    final view = ref.watch(viewProvider);
    if (state == null || view == null) return const [];
    final level = view.level.level.round();
    final tool = ref.watch(heldToolProvider);
    final fx = ref.watch(bedFxProvider);
    final rewards = ref.watch(rewardsProvider);
    final hoverBed = game.hoverBed.value;
    final hoverSpot = game.hoverSpot.value;
    final reveal = game.revealNames.value;
    final sessions = state.sessions;
    final back = <Widget>[];
    final front = <Widget>[];

    for (final bed in beds) {
      final at = village.plotAt(bed.index);
      final session = bed.unlockLevel == null ? stationOf(sessions, bed.station) : null;
      final plot = bed.unlockLevel != null ? lockedPlot(bed, level) : plotOf(view, session);
      final words = _plotWords(bed, session, plot, level, tool, hoverBed, fx, rewards, sessions);
      if (words == null) continue;
      final card = switch (words.at) {
        'middle' => _Pin(at.x * s, (at.y - plotH / 2) * s, words.card, ay: 0.5),
        'rail' => _Pin(at.x * s, (at.y - plotH + _rail) * s - 2, words.card),
        _ => _Pin(at.x * s, (at.y - plotH - 3) * s - 2, words.card),
      };
      (words.at == 'above' ? front : back).add(card);
    }

    for (final h in sessions) {
      final head = game.heads[h.id];
      if (head == null) continue;
      final doing = doingOf(h);
      final named = h.phase is PhaseArriving;
      final act = 'act-${doing.action.wire}';
      if (doing.action == SessionAction.none && !named) continue;
      back.add(
        _Pin(
          head.x * s,
          head.y * s - 2,
          PixelCard(
            padX: 3,
            padY: 2,
            rows: [
              [if (doing.action != SessionAction.none && atlas.has(act)) Icon(atlas[act], 18), if (named) Words(h.name)],
            ],
          ),
        ),
      );
    }

    final said = _managerWords(state);
    if (said != null) {
      back.add(
        _Pin(
          village.manager.x * s,
          (village.manager.y - 34) * s - 4,
          PixelCard(
            maxWidth: 220,
            maxLines: 3,
            rows: [
              [Words(said)],
            ],
          ),
        ),
      );
    }

    final tips = <Widget>[];
    var i = 0;
    for (final MapEntry(key: spot, value: box) in village.spotBoxes.entries) {
      final top = box.y0 < _topEdge ? box.y0 + _signInside : box.y0;
      final cx = (box.x0 + box.x1) / 2;
      final (label, hint) = spotNames[spot]!;
      if (hoverSpot == spot) {
        tips.add(
          _Pin(
            cx * s,
            top * s - 4,
            PixelCard(
              center: true,
              rows: [
                [Words(label)],
                [Words(hint, color: CardColors.muted)],
              ],
            ),
          ),
        );
      } else if (reveal) {
        tips.add(
          _Pin(
            cx * s,
            top * s - 4,
            PixelCard(
              center: true,
              padX: 3,
              padY: 1,
              rows: [
                [Words(label)],
              ],
            ),
          ),
        );
      } else if (_sign[spot] case final icon? when atlas.has(icon)) {
        final hop = ((game.t * 1000 / 350 + i * 2.3).floor() % 9 == 0) ? 1.0 : 0.0;
        back.add(
          _Pin(
            cx * s,
            (top - hop) * s - _signGap * s,
            PixelCard(
              paper: CardColors.wood,
              padX: 2,
              padY: 2,
              rows: [
                [Icon(atlas[icon], 22)],
              ],
            ),
          ),
        );
      }
      i++;
      final count = switch (spot) {
        'warehouse' => harvestedOf(state).length,
        'plans' => ref.watch(plansProvider).where((p) => p.asksForYou ?? false).length,
        _ => 0,
      };
      if (count > 0) {
        back.add(
          _Pin(
            box.x1 * s,
            box.y0 * s,
            PixelCard(
              paper: CardColors.bug,
              ink: CardColors.lightInk,
              padX: 3,
              padY: 0,
              rows: [
                [Words('$count')],
              ],
            ),
            ay: 0.5,
          ),
        );
      }
    }
    // What is pointed at comes up over the rest: a plot's card over the helpers' bubbles, a thing's name over all.
    return [...back, ...front, ...tips];
  }

  PlotWords? _plotWords(
    Bed bed,
    Session? session,
    PlotView plot,
    int level,
    Tool tool,
    int? hoverBed,
    List<BedFxEntry> fx,
    List<GameEffectReward> rewards,
    List<Session> sessions,
  ) {
    if (hoverBed == bed.index) {
      final aim = aimTool(tool, bed, session, plot, level);
      return (
        at: 'above',
        card: PixelCard(
          center: true,
          rows: [
            [Words(plotTitle(bed, session, plot.crop))],
            if (session?.project != null) [Words(session!.project!, color: CardColors.muted)],
            [Words(aim.ok ? '点击：${aim.text}' : aim.text, color: aim.ok ? CardColors.good : CardColors.muted)],
          ],
        ),
      );
    }
    final reward = bed.station < 0 ? null : rewards.where((r) => sessions.any((h) => h.id == r.sessionId && stationOfSession(h) == bed.station)).lastOrNull;
    if (reward != null) {
      return (
        at: 'rail',
        card: PixelCard(
          rows: [
            [Icon(widget.game.atlas['icon-coin'], 12), Words('+${reward.coins.round()}')],
          ],
        ),
      );
    }
    final note = fx.where((f) => f.bed == bed.index && (f.kind == BedFxKind.note || f.kind == BedFxKind.harvest)).lastOrNull;
    if (note != null) {
      return (
        at: 'rail',
        card: PixelCard(
          rows: [
            [Words(note.text ?? '')],
          ],
        ),
      );
    }
    final badge = plot.badge;
    if (badge != null) {
      final (paper, ink) = _tone[badge.tone]!;
      return (
        at: 'rail',
        card: PixelCard(
          paper: paper,
          ink: ink,
          rows: [
            [Words(badge.text)],
          ],
        ),
      );
    }
    if (bed.unlockLevel != null && plot.crop == Crop.locked) {
      return (
        at: 'middle',
        card: PixelCard(
          rows: [
            [Words('Lv.${bed.unlockLevel} 开垦')],
          ],
        ),
      );
    }
    return null;
  }

  String? _managerWords(CoreState state) {
    final line = lastManagerSaid(state.chat, ref.watch(spokenProvider));
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    if (line != null && line.key != _heardKey) {
      _heardKey = line.key;
      _finalAt = null;
    }
    if (line != null && line.final_ && _finalAt == null) _finalAt = now;
    final fresh = line != null && (_finalAt == null || now - _finalAt! < _speechMs);
    if (ref.watch(chatOpenProvider) || widget.game.revealNames.value) return null;
    if (fresh) return plainText(line.text);
    return state.sessions.isEmpty ? '今天种点什么？' : null;
  }
}

class VillageHud extends ConsumerWidget {
  const VillageHud({super.key, required this.game, required this.call});
  final VillageGame game;

  final VoiceCall call;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = game.atlas;
    final view = ref.watch(viewProvider);
    final state = ref.watch(stateProvider);
    final lv = view?.level ?? const FarmLevel(level: 1, xp: 0, need: 10);
    final level = lv.level.round();
    final need = lv.need.round();
    final next = nextClearing(level);
    final coins = (state?.progress?.coins ?? 0).toDouble();
    final look = ref.watch(prefsProvider.select((p) => p.managerLook)) ?? 'farmer';
    final face = look != 'farmer' && atlas.has('manager-$look-face') ? 'manager-$look-face' : 'manager-face';
    final held = ref.watch(heldToolProvider);
    final unread = unreadTotal(state?.chat);
    final phoneOpen = ref.watch(phoneOpenProvider);
    void open(FarmPanel which) {
      Sfx.play('open');
      ref.read(panelProvider.notifier).set(which);
    }

    return Stack(
      children: [
        Positioned(
          left: hudEdge,
          top: hudEdge,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Tap(
                onTap: () => open(FarmPanel.manager),
                label: '换管家的样子',
                child: PixelCard(
                  width: hudTop + 2,
                  height: hudTop,
                  padX: 0,
                  padY: 0,
                  center: true,
                  rows: [
                    [Icon(atlas[face], hudTop - 8)],
                  ],
                ),
              ),
              const SizedBox(width: hudGap),
              _Tap(
                onTap: () => open(FarmPanel.tasks),
                label: '任务与成就',
                child: TweenAnimationBuilder<double>(
                  tween: Tween(end: coins),
                  duration: const Duration(milliseconds: 600),
                  curve: Curves.easeOut,
                  builder: (context, shown, _) => FramesBuilder(
                    game: game,
                    builder: (context) => PixelCard(
                      height: hudTop,
                      rows: [
                        [
                          Words('Lv.$level', color: CardColors.good),
                          Icon(atlas['icon-coin'], 12),
                          Words(_thousands(shown.round())),
                          Icon(atlas['icon-clock'], 12),
                          Words(clockText(game.tod)),
                        ],
                        [Bar(need == 0 ? 0 : lv.xp / need, w: 150, h: 6)],
                        [Words('${lv.xp.round()}/$need commit${next != null ? ' · Lv.$next 开垦' : ''}', color: CardColors.muted)],
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        Positioned(
          right: hudEdge,
          top: hudEdge,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (MediaQuery.sizeOf(context).width >= 640) ...[
                _Tap(
                  onTap: () {
                    Sfx.play('open');
                    context.go('/map');
                  },
                  label: '地图：每个项目一座岛',
                  child: HudCard(
                    height: hudTop,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Image.asset(atlas['icon-map'].asset, width: 20, height: 20, filterQuality: FilterQuality.none),
                        const SizedBox(width: 4),
                        const Text('地图'),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: hudGap),
              ],
              _Tap(
                onTap: () {
                  Sfx.play('open');
                  context.go('/chat');
                },
                label: unread > 0 ? '频道，$unread 条没读' : '频道',
                child: HudCard(
                  height: hudTop,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Image.asset(atlas['icon-board'].asset, width: 20, height: 20, filterQuality: FilterQuality.none),
                      const SizedBox(width: 4),
                      const Text('频道'),
                      if (unread > 0) ...[
                        const SizedBox(width: 4),
                        Container(
                          color: const Color(0xFFC84A3A),
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          child: Text('$unread', style: const TextStyle(fontSize: 10, color: Color(0xFFF7E8C4))),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              const SizedBox(width: hudGap),
              const QuotaPill(height: hudTop),
              const SizedBox(width: hudGap),
              _Tap(
                onTap: () {
                  Sfx.play('open');
                  ref.read(menuOpenProvider.notifier).set(true);
                },
                label: '菜单（Esc）',
                child: const PixelCard(
                  height: hudTop,
                  rows: [
                    [Words('菜单'), Words('Esc', color: CardColors.muted)],
                  ],
                ),
              ),
            ],
          ),
        ),
        Positioned(
          left: hudEdge,
          bottom: hudEdge,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (phoneOpen) ...[FarmPhone(call: call), const SizedBox(height: hudGap)],
              PhoneButton(call: call, height: hudBottom),
              const SizedBox(height: hudGap),
              const FriendsDock(height: hudBottom),
            ],
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: hudEdge,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (final (i, tool) in Tool.values.indexed) ...[
                if (i > 0) const SizedBox(width: hudGap),
                _Tap(
                  onTap: () => ref.read(heldToolProvider.notifier).set(tool),
                  label: '${tool.label}：${tool.hint}（${i + 1}）',
                  selected: held == tool,
                  child: PixelCard(
                    paper: held == tool ? CardColors.held : CardColors.slot,
                    padX: 3,
                    padY: 2,
                    width: 52,
                    height: hudBottom,
                    center: true,
                    rows: [
                      [Words('${i + 1}', color: CardColors.muted), Icon(atlas[tool.icon], 24)],
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

String _thousands(int n) => n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');

class _Tap extends StatelessWidget {
  const _Tap({required this.onTap, required this.label, required this.child, this.selected});
  final VoidCallback onTap;
  final String label;
  final Widget child;
  final bool? selected;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: label,
    selected: selected,
    child: Tooltip(
      message: label,
      waitDuration: const Duration(milliseconds: 500),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: onTap,
          child: ExcludeSemantics(child: child),
        ),
      ),
    ),
  );
}

Tool? toolForKey(LogicalKeyboardKey key) {
  final n = LogicalKeyboardKey.digit1.keyId;
  final i = key.keyId - n;
  return i >= 0 && i < Tool.values.length ? Tool.values[i] : null;
}
