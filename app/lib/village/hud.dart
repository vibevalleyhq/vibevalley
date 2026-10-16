// What is drawn over the village, at screen pixels so the words stay sharp (web/src/pixel/overlay.ts, words.ts,
// headsup.ts, Hud.tsx). The overlay: over a plot, what it is and what the tool in hand would do (while pointed at), the
// coins it just earned, a note, its badge; over a helper, what it is doing (and its name as it arrives); over the
// manager, his last words; over a thing in the yard, its name while pointed at (or while ⌥ is held), its wooden sign
// otherwise, and how many things wait there. The HUD: the manager's face and the farm's status at the top left, the
// map, the channels, the energy pill and the menu at the top right, the phone and the helpers at the bottom left, the
// tools along the bottom. Words let clicks through to the village; the HUD's parts are buttons.

import 'package:flutter/material.dart' hide Icon;
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../rules/warehouse.dart' show harvestedOf;
import '../data/providers.dart';
import '../desk/chat/chat_state.dart' show chatOpenProvider, spokenProvider;
import '../farm/friends.dart';
import '../farm/quota.dart';
import '../game/farm.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../phone/phone.dart';
import '../shell/prefs.dart';
import '../shell/sfx.dart';
import '../ui/kit/markdown.dart' show plainText;
import '../ui/pixel_card.dart';
import '../voice/voice.dart';
import 'game.dart';
import 'world.dart' show plotH, spotNames;
import '../rules/chat.dart';
import '../rules/clock.dart';
import '../rules/farm.dart';
import '../rules/playbook.dart';
import '../rules/progress.dart';

/// The HUD stands this far from the game screen's edges, and its parts this far apart (headsup.ts EDGE, GAP).
const hudEdge = 8.0;
const hudGap = 4.0;

/// The top row's height (the status card's) and the bottom row's (a tool slot's).
const hudTop = 52.0;
const hudBottom = 36.0;

/// A plot's badge stands this far below its frame's top, on its back rail (overlay.ts RAIL).
const _rail = 5.0;

/// A thing's sign hangs this far over its picture; one near the top of the map hangs inside it (overlay.ts).
const _signGap = 3.0;
const _topEdge = 20.0;
const _signInside = 30.0;

/// How long the manager's last sentence stays over his head (words.ts SPEECH_MS).
const _speechMs = 9000;

const _tone = {
  BadgeTone.ripe: (CardColors.ripe, CardColors.ink),
  BadgeTone.bug: (CardColors.bug, CardColors.lightInk),
  BadgeTone.stuck: (CardColors.stuck, CardColors.lightInk),
  BadgeTone.rest: (CardColors.rest, CardColors.ink),
};

/// The little wooden sign over each thing in the yard (words.ts SIGN); the manager has none: he talks.
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

/// Puts `child` with its point (the middle, `ay` of its height) at (`x`, `y`) in the stack.
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

/// Rebuilds with every frame the village draws. The village may tick while the screen is being laid out (its first
/// resize), so a tick then waits for the end of that frame.
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

/// The words of a plot: where they go (above it while pointed at, on its back rail, or in its middle) and the card.
typedef PlotWords = ({String at, PixelCard card});

/// What a plot is, for screen readers and its title (words.ts plotTitle).
String plotTitle(Bed bed, Helper? worker, Crop crop) {
  if (bed.unlockLevel != null) return crop == Crop.locked ? '没开垦的地' : '花坛';
  if (worker == null) return '第 ${bed.station + 1} 块地 · 空地';
  return '${worker.name} · ${cropLabel[crop]}';
}

/// The manager's last line, typed on the square or said aloud (core chat.ts lastForemanSaid).
({String key, String text, bool final_, double at})? lastForemanSaid(Chat? chat, List<Line> lines) {
  final square = squareOf(chat);
  final typed = square == null ? null : messagesIn(chat, square.id).where((m) => m.fromKind == SenderKind.foreman && m.kind == MessageKind.chat).lastOrNull;
  final aloud = lines.where((l) => l.role == LineRole.foreman).lastOrNull;
  final a = typed == null ? null : (key: 'm${typed.seq}', text: typed.text, final_: typed.final_, at: typed.at);
  final b = aloud == null ? null : (key: 's${aloud.id}', text: aloud.text, final_: aloud.final_, at: aloud.at);
  if (a == null) return b;
  if (b == null) return a;
  return a.at >= b.at ? a : b;
}

/// The words over the village: plots, helpers, the manager, the things in the yard. Redrawn every frame the game
/// draws; never takes a click.
class VillageOverlay extends ConsumerStatefulWidget {
  const VillageOverlay({super.key, required this.game, required this.scale});
  final VillageGame game;
  final double scale;

  @override
  ConsumerState<VillageOverlay> createState() => _VillageOverlayState();
}

class _VillageOverlayState extends ConsumerState<VillageOverlay> {
  // The manager's line as last heard: its key, and when it was final (words.ts managerWords' `heard`).
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
    final state = ref.watch(farmProvider);
    final view = ref.watch(viewProvider);
    if (state == null || view == null) return const [];
    final level = view.level.level.round();
    final tool = ref.watch(heldToolProvider);
    final fx = ref.watch(bedFxProvider);
    final rewards = ref.watch(rewardsProvider);
    final hoverBed = game.hoverBed.value;
    final hoverSpot = game.hoverSpot.value;
    final reveal = game.revealNames.value;
    final helpers = state.helpers;
    final back = <Widget>[];
    final front = <Widget>[];

    // ── Plots ──
    for (final bed in beds) {
      final at = village.plotAt(bed.index);
      final worker = bed.unlockLevel == null ? stationOf(helpers, bed.station) : null;
      final plot = bed.unlockLevel != null ? lockedPlot(bed, level) : plotOf(view, worker);
      final words = _plotWords(bed, worker, plot, level, tool, hoverBed, fx, rewards, helpers);
      if (words == null) continue;
      final card = switch (words.at) {
        'middle' => _Pin(at.x * s, (at.y - plotH / 2) * s, words.card, ay: 0.5),
        'rail' => _Pin(at.x * s, (at.y - plotH + _rail) * s - 2, words.card),
        _ => _Pin(at.x * s, (at.y - plotH - 3) * s - 2, words.card),
      };
      (words.at == 'above' ? front : back).add(card);
    }

    // ── Helpers: what each is doing over its head, and its name as it arrives ──
    for (final h in helpers) {
      final head = game.heads[h.id];
      if (head == null) continue;
      final doing = doingOf(h);
      final named = h.phase is PhaseArriving;
      final act = 'act-${doing.action.wire}';
      if (doing.action == WorkerAction.none && !named) continue;
      back.add(
        _Pin(
          head.x * s,
          head.y * s - 2,
          PixelCard(
            padX: 3,
            padY: 2,
            rows: [
              [if (doing.action != WorkerAction.none && atlas.has(act)) Icon(atlas[act], 18), if (named) Words(h.name)],
            ],
          ),
        ),
      );
    }

    // ── The manager's words ──
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

    // ── Things in the yard: a sign (or the name), how many wait there ──
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
        // Now and then a sign gives a little hop, each at its own time, to say it can be clicked.
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
        'plans' => ref.watch(plansProvider).where(asksForYou).length,
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

  /// Over a plot (words.ts plotWords): what it is while pointed at; else the coins it just earned, a note, its badge,
  /// when it opens.
  PlotWords? _plotWords(
    Bed bed,
    Helper? worker,
    PlotView plot,
    int level,
    Tool tool,
    int? hoverBed,
    List<BedFxEntry> fx,
    List<GameEffectReward> rewards,
    List<Helper> helpers,
  ) {
    if (hoverBed == bed.index) {
      final aim = aimTool(tool, bed, worker, plot, level);
      return (
        at: 'above',
        card: PixelCard(
          center: true,
          rows: [
            [Words(plotTitle(bed, worker, plot.crop))],
            if (worker?.project != null) [Words(worker!.project!, color: CardColors.muted)],
            [Words(aim.ok ? '点击：${aim.text}' : aim.text, color: aim.ok ? CardColors.good : CardColors.muted)],
          ],
        ),
      );
    }
    final reward = bed.station < 0 ? null : rewards.where((r) => helpers.any((h) => h.id == r.workerId && stationOfHelper(h) == bed.station)).lastOrNull;
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

  /// The manager's words (words.ts managerWords): his last sentence for a while, or a nudge on an empty farm; nothing
  /// while the chat is open or the names show.
  String? _managerWords(FarmState state) {
    final line = lastForemanSaid(state.chat, ref.watch(spokenProvider));
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    if (line != null && line.key != _heardKey) {
      _heardKey = line.key;
      _finalAt = null;
    }
    if (line != null && line.final_ && _finalAt == null) _finalAt = now;
    final fresh = line != null && (_finalAt == null || now - _finalAt! < _speechMs);
    if (ref.watch(chatOpenProvider) || widget.game.revealNames.value) return null;
    if (fresh) return plainText(line.text);
    return state.helpers.isEmpty ? '今天种点什么？' : null;
  }
}

/// The HUD inside the game screen (headsup.ts, Hud.tsx): each part a button.
class VillageHud extends ConsumerWidget {
  const VillageHud({super.key, required this.game, required this.call});
  final VillageGame game;

  /// The manager's voice call, for the phone.
  final VoiceCall call;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = game.atlas;
    final view = ref.watch(viewProvider);
    final state = ref.watch(farmProvider);
    final lv = view?.level ?? const FarmLevel(level: 1, xp: 0, need: 10);
    final level = lv.level.round();
    final need = xpToNext(level);
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
        // The top left: the manager's face (his looks), the farm's status (the tasks).
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
                  // The coins as shown count up to the real number.
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
        // The top right: the map (where there is room for it), the channels and the energy pill, left of the menu.
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
        // The lower-left corner: the phone (up over its button while out) over the helpers.
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
        // The tools, a hotbar along the bottom (click one or press its number).
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

/// 1,234 (toLocaleString).
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

/// The number keys pick a tool, as on the web page (engine useToolHotkeys); Esc puts it down (the farm screen).
Tool? toolForKey(LogicalKeyboardKey key) {
  final n = LogicalKeyboardKey.digit1.keyId;
  final i = key.keyId - n;
  return i >= 0 && i < Tool.values.length ? Tool.values[i] : null;
}
