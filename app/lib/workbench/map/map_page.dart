import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/sessions.dart';
import '../../rules/cast.dart';
import '../../sprites/atlas.dart';
import '../../ui/pro/pro.dart';
import '../../village/island_cards.dart';
import '../../data/remote.dart' show agentsProvider, projectCatalogProvider;
import '../projects/codebase.dart' show growthOf;
import '../projects/projects_page.dart' show since;
import '../../shared/faces.dart' show AgentFaceOf, PoseSprite;
import '../../shared/swatches.dart';
import '../shared/widgets.dart';
import '../issues/issues_page.dart' show writeIssueAndOpen;
import 'map_rules.dart';
import 'seed_bag_view.dart';

/// The issues and helpers come with the farm's state.
const _pollEvery = Duration(seconds: 30);

const _gap = 24.0;

const _parchment = Color(0xFFEBD9AE);

/// The whole map: every project an island; a tap on one opens it on the projects page.
class ProjectMap extends ConsumerWidget {
  const ProjectMap({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final farm = ref.watch(stateProvider);
    final sessions = farm?.sessions ?? const <Session>[];
    final projects = ref.watch(projectCatalogProvider).value;
    if (atlas == null) return const SizedBox.shrink();
    return _MapView(
      atlas: atlas,
      islands: islandsNow(ref),
      homeless: homeless(sessions),
      loading: projects == null,
      selected: null,
      onOpen: (project) => workbenchGo(context, project == null ? '/projects' : '/projects/${Uri.encodeComponent(project)}'),
    );
  }
}

/// The islands as the farm stands now.
List<Island> islandsNow(WidgetRef ref) {
  final farm = ref.watch(stateProvider);
  return islandsOf(
    projects: ref.watch(projectCatalogProvider).value ?? const [],
    sessions: farm?.sessions ?? const <Session>[],
    plots: ref.watch(viewProvider)?.plots ?? const <String, PlotView>{},
    issues: farm?.issues ?? const [],
  );
}

/// How often the projects page asks again what projects there are.
const projectsPollEvery = _pollEvery;

class _MapView extends StatelessWidget {
  const _MapView({required this.atlas, required this.islands, required this.homeless, required this.loading, required this.selected, required this.onOpen});
  final SpriteAtlas atlas;
  final List<Island> islands;
  final List<Session> homeless;
  final bool loading;
  final String? selected;
  final ValueChanged<String?> onOpen;

  @override
  Widget build(BuildContext context) {
    // So they line up.
    final looks = [
      for (final l in islandLooks)
        if (atlas.has(l)) atlas[l],
    ];
    final cell = looks.isEmpty ? const Size(300, 200) : Size(looks.fold(0.0, (w, l) => w > l.w ? w : l.w), looks.fold(0.0, (h, l) => h > l.h ? h : l.h));
    // The same side gap as the list beside or above it (ListDetail's).
    final gap = MediaQuery.sizeOf(context).width >= 640 ? 12.0 : 8.0;
    return Padding(
      padding: EdgeInsets.fromLTRB(gap, 0, gap, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Toolbar(islands: islands),
          const SizedBox(height: 8),
          Expanded(
            child: _Parchment(
              atlas: atlas,
              child: LayoutBuilder(
                builder: (context, box) {
                  final inner = box.maxWidth - 2 * 16;
                  final scale = islandScale(inner, cell.width, _gap);
                  return SingleChildScrollView(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (loading && islands.isEmpty)
                            Text('在找……', style: ProText.sm.copyWith(color: ProColor.muted))
                          else if (islands.isEmpty)
                            const _NoProjects()
                          else
                            Wrap(
                              spacing: _gap,
                              runSpacing: _gap,
                              alignment: WrapAlignment.center,
                              children: [
                                for (final i in islands)
                                  SizedBox(
                                    width: cell.width * scale,
                                    child: _IslandView(
                                      island: i,
                                      atlas: atlas,
                                      scale: scale,
                                      cellHeight: cell.height,
                                      selected: i.project == selected,
                                      onOpen: onOpen,
                                    ),
                                  ),
                              ],
                            ),
                          if (homeless.isNotEmpty) ...[const SizedBox(height: 16), _Homeless(sessions: homeless)],
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Toolbar extends StatelessWidget {
  const _Toolbar({required this.islands});
  final List<Island> islands;

  static const _oneLine = 640.0;

  @override
  Widget build(BuildContext context) {
    final tally = mapTally(islands);
    // So a narrow line breaks between them.
    final pieces = ['${islands.length} 座岛', '${tally.peopled} 座有人', '在干 ${tally.working}/$maxRunning 块地', if (tally.queued > 0) '排队 ${tally.queued}'];
    final counts = Wrap(
      runSpacing: 2,
      children: [
        for (final (i, words) in pieces.indexed) Text(i < pieces.length - 1 ? '$words · ' : words, style: ProText.sm.copyWith(fontWeight: FontWeight.w500)),
      ],
    );
    final marks = Wrap(
      spacing: 16,
      runSpacing: 4,
      children: [
        for (final (icon, words) in const [('map-stake', '空位，点了派活'), ('plot-locked', '农场的地都占着'), ('map-sack', '排队的活')])
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SpriteIcon(icon, size: 18),
              const SizedBox(width: 4),
              Text(words, style: ProText.meta),
            ],
          ),
      ],
    );
    final write = Consumer(
      builder: (context, ref, _) => ProButton.text('写一张工单', icon: 'button-add', onPressed: () => writeIssueAndOpen(context, ref.read(apiProvider))),
    );
    return LayoutBuilder(
      builder: (context, box) => box.maxWidth < _oneLine
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(child: counts),
                    const SizedBox(width: 12),
                    write,
                  ],
                ),
                const SizedBox(height: 6),
                marks,
              ],
            )
          : Row(
              children: [
                counts,
                const SizedBox(width: 20),
                Expanded(child: marks),
                const SizedBox(width: 12),
                write,
              ],
            ),
    );
  }
}

class _Parchment extends StatefulWidget {
  const _Parchment({required this.atlas, required this.child});
  final SpriteAtlas atlas;
  final Widget child;

  @override
  State<_Parchment> createState() => _ParchmentState();
}

const _clouds = [(0.08, 0.1, 9.0), (0.46, 0.62, 6.0), (0.78, 0.35, 11.0)];

class _ParchmentState extends State<_Parchment> with SingleTickerProviderStateMixin {
  // The clouds are slow, and move a whole pixel or so at a time.
  late final Ticker _ticker = createTicker((elapsed) {
    final t = elapsed.inMilliseconds / 1000;
    if ((t * 10).floor() != (_t * 10).floor()) setState(() => _t = t);
  });
  double _t = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (still && _ticker.isActive) _ticker.stop();
    if (!still && !_ticker.isActive) _ticker.start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final atlas = widget.atlas;
    final cloud = atlas.has('map-cloud') ? atlas['map-cloud'] : null;
    final compass = atlas.has('map-compass') ? atlas['map-compass'] : null;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: const BoxDecoration(color: _parchment, border: Border.fromBorderSide(proLine), borderRadius: BorderRadius.all(Radius.circular(8))),
      child: LayoutBuilder(
        builder: (context, box) => Stack(
          children: [
            const Positioned.fill(child: CustomPaint(painter: _GridPainter())),
            if (cloud != null)
              for (final (y, from, speed) in _clouds)
                Positioned(
                  left: ((from * (box.maxWidth + cloud.w * 2) + _t * speed) % (box.maxWidth + cloud.w * 2) - cloud.w * 2).roundToDouble(),
                  top: (y * box.maxHeight).roundToDouble(),
                  child: Opacity(opacity: .55, child: PixelSprite(cloud, scale: 2)),
                ),
            if (compass != null && box.maxWidth >= 700) Positioned(right: 16, bottom: 16, child: Opacity(opacity: .8, child: PixelSprite(compass, scale: 1.5))),
            Positioned.fill(child: widget.child),
          ],
        ),
      ),
    );
  }
}

class _GridPainter extends CustomPainter {
  const _GridPainter();

  static const _every = 64.0;

  @override
  void paint(Canvas canvas, Size size) {
    final ink = Paint()..color = Palette.cream300.withValues(alpha: .45);
    for (var x = _every; x < size.width; x += _every) {
      for (var y = 0.0; y < size.height; y += 8) {
        canvas.drawRect(Rect.fromLTWH(x.roundToDouble(), y, 2, 4), ink);
      }
    }
    for (var y = _every; y < size.height; y += _every) {
      for (var x = 0.0; x < size.width; x += 8) {
        canvas.drawRect(Rect.fromLTWH(x, y.roundToDouble(), 4, 2), ink);
      }
    }
  }

  @override
  bool shouldRepaint(_GridPainter old) => false;
}

class _IslandView extends ConsumerWidget {
  const _IslandView({required this.island, required this.atlas, required this.scale, required this.cellHeight, required this.selected, required this.onOpen});
  final Island island;
  final SpriteAtlas atlas;
  final double scale;

  /// Art pixels: every island stands on the same line.
  final double cellHeight;
  final bool selected;
  final ValueChanged<String?> onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = scale;
    final pic = atlas.first([islandLook(island.project), ...islandLooks]);
    final yard = pic.yard ?? Rect.fromLTWH(pic.w * .25, pic.h * .25, pic.w * .5, pic.h * .4);
    final at = plotsIn(yard, island.spots.length);
    final agents = ref.watch(agentsProvider).value ?? const <String, Agent>{};
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    void go(String path) => workbenchGo(context, path);
    // Inside the island's place: the bag sows in this project, no bed and no project to choose.
    void sow() => showProDialog<void>(
      context,
      title: Text('播种 · ${island.project}'),
      builder: (dialog) => MapSeedForm(project: island.project, onDone: () => Navigator.of(dialog).pop()),
    );

    Widget place(SpriteInfo sp, Offset foot, {Widget? child, VoidCallback? onTap, String? tip, String? label}) {
      final picture = child ?? PixelSprite(sp, scale: s);
      return Positioned(
        left: (foot.dx - sp.ax) * s,
        top: (foot.dy - sp.ay) * s,
        child: onTap == null && tip == null ? picture : Tappable(onTap: onTap, tooltip: tip, semanticLabel: label, builder: (_, _) => picture),
      );
    }

    final layers = <Widget>[
      Positioned.fill(
        child: Tappable(
          onTap: () => onOpen(island.project),
          semanticLabel: '${island.project}：${islandText(island)}',
          builder: (_, _) => Align(
            alignment: Alignment.bottomCenter,
            child: PixelSprite(pic, scale: s),
          ),
        ),
      ),
    ];
    final down = cellHeight - pic.h;
    for (final (i, spot) in island.spots.indexed) {
      final foot = at[i] + Offset(0, down);
      final tip = spotText(spot, now);
      switch (spot) {
        case SpotTaken(:final session, :final plot):
          final open = '/issues/${Uri.encodeComponent(session.id)}';
          final cast = castOf(agents[session.agent]?.look, session.agent);
          final pose = mapPose(session);
          final body = castSprite(atlas, cast, pose);
          layers
            ..add(place(atlas.first([cropSprite(plot.crop), 'plot-seeded']), foot, onTap: () => go(open), tip: tip, label: '${session.name}的地'))
            ..add(
              place(
                body,
                foot + sessionInPlot,
                child: PoseSprite(cast: cast, pose: pose, scale: s),
                onTap: () => go(open),
                tip: tip,
                label: session.name,
              ),
            );
          if (plot.badge case final badge?) {
            layers.add(
              Positioned(
                left: foot.dx * s,
                top: (foot.dy - 3) * s,
                child: IgnorePointer(
                  child: FractionalTranslation(
                    translation: const Offset(-.5, 0),
                    child: PlotSign(text: badge.text, tone: badge.tone),
                  ),
                ),
              ),
            );
          }
        case SpotOpen():
          layers
            ..add(place(atlas['plot-empty'], foot, onTap: sow, tip: tip, label: '空位，派一件活到 ${island.project}'))
            ..add(place(atlas['map-stake'], foot + const Offset(9, -12), onTap: sow, tip: tip));
        case SpotShut():
          layers.add(place(atlas['plot-locked'], foot, tip: tip, label: '等地'));
      }
    }
    final gate = Offset(yard.center.dx, yard.bottom + down);
    final sacks = island.queued.take(3).toList();
    for (final (i, item) in sacks.indexed) {
      final foot = gate + Offset(16.0 + i * 13, 15);
      layers.add(
        place(atlas['map-sack'], foot, onTap: () => go('/issues/${Uri.encodeComponent(item.id)}'), tip: '排队：${item.title}', label: '排队的活：${item.title}'),
      );
      if (i == sacks.length - 1 && island.queued.length > sacks.length) {
        layers.add(
          Positioned(
            left: (foot.dx + 6) * s,
            top: (foot.dy - 20) * s,
            child: IgnorePointer(child: MoreSacks(island.queued.length - sacks.length)),
          ),
        );
      }
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: double.infinity,
          height: cellHeight * s,
          child: Center(
            child: SizedBox(
              width: pic.w * s,
              height: cellHeight * s,
              child: Stack(clipBehavior: Clip.none, children: layers),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Tappable(
          onTap: () => onOpen(island.project),
          selected: selected,
          semanticLabel: island.project,
          builder: (_, st) => IslandSign(
            project: island.project,
            line: islandText(island),
            selected: selected,
            hovered: st.hovered,
            maxWidth: pic.w * s - 24,
            enter: atlas.has('button-next') ? atlas['button-next'] : null,
          ),
        ),
      ],
    );
  }
}

class _Homeless extends StatelessWidget {
  const _Homeless({required this.sessions});
  final List<Session> sessions;

  @override
  Widget build(BuildContext context) => Center(
    child: ProPanel(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text('不在哪个项目里：', style: ProText.meta),
          for (final h in sessions)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AgentFaceOf(h.agent, size: 20),
                const SizedBox(width: 4),
                DefaultTextStyle(
                  style: ProText.sm,
                  child: InlineLink(h.name, onTap: () => workbenchGo(context, '/issues/${Uri.encodeComponent(h.id)}')),
                ),
              ],
            ),
        ],
      ),
    ),
  );
}

class _NoProjects extends StatelessWidget {
  const _NoProjects();

  @override
  Widget build(BuildContext context) => Center(
    child: ProPanel(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('工作目录下还没有项目，地图上还是一片海。', style: ProText.sm.copyWith(color: ProColor.muted)),
          const SizedBox(height: 12),
          ProButton.text('去开一块地', tone: ProTone.primary, onPressed: () => workbenchGo(context, '/projects')),
        ],
      ),
    ),
  );
}

/// One island: its plots (the issues being worked), the room left, what waits.
class IslandDetail extends StatelessWidget {
  const IslandDetail({super.key, required this.island});
  final Island island;

  @override
  Widget build(BuildContext context) => Ticking(
    builder: (context, now) {
      final last = island.summary?.last;
      final growth = growthOf(last, now);
      final shut = island.spots.whereType<SpotShut>().length;
      final taken = island.spots.whereType<SpotTaken>().toList();
      return ProCard(
        title: island.project,
        aside: Text(islandText(island)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                SpriteIcon('plot-${growth.crop}', size: 36),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    island.summary == null ? '工作目录里没有这个项目了，只剩还在岛上的帮工。' : '长势 · ${growth.label}${last != null ? ' · 最近一次提交：${since(last, now)}' : ''}',
                    style: ProText.sm.copyWith(color: ProColor.muted),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Text(
              'worktree · ${taken.length} 个',
              style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            if (taken.isEmpty) const EmptyNote('岛上还没有帮工：每派一件活来，就多一个 worktree。') else for (final t in taken) _WorktreeRow(spot: t, now: now),
            const SizedBox(height: 12),
            Row(
              children: [
                SpriteIcon(island.open > 0 ? 'map-stake' : 'plot-locked', size: 24),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    island.summary == null
                        ? '不再往这里派活。'
                        : island.open > 0
                        ? '还能再派 ${island.open} 件活，马上开工（这个项目最多同时 ${island.maxSessions} 个帮工）。'
                        : shut > 0
                        ? '农场的 $maxRunning 块地都有人在干活，派来的活先排队。'
                        : '满了：${island.maxSessions} 个帮工都在干活，派来的活先排队。',
                    style: ProText.sm.copyWith(color: ProColor.muted),
                  ),
                ),
                if (island.summary != null) ...[
                  const SizedBox(width: 8),
                  Consumer(
                    builder: (context, ref, _) => ProButton.text(
                      '派一件活',
                      tone: island.open > 0 ? ProTone.primary : ProTone.plain,
                      onPressed: () => writeIssueAndOpen(context, ref.read(apiProvider), project: island.project),
                    ),
                  ),
                ],
              ],
            ),
            if (island.queued.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text(
                '排队 · ${island.queued.length} 件',
                style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 6),
              for (final item in island.queued)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(
                    children: [
                      const SpriteIcon('map-sack', size: 20),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(item.title, style: ProText.sm, maxLines: 1, overflow: TextOverflow.ellipsis),
                      ),
                      const SizedBox(width: 8),
                      ProButton.icon(
                        'button-open',
                        tooltip: '看这张工单',
                        semanticLabel: '看这张工单',
                        iconSize: 14,
                        onPressed: () => workbenchGo(context, '/issues/${Uri.encodeComponent(item.id)}'),
                      ),
                    ],
                  ),
                ),
            ],
          ],
        ),
      );
    },
  );
}

class _WorktreeRow extends StatelessWidget {
  const _WorktreeRow({required this.spot, required this.now});
  final SpotTaken spot;
  final double now;

  @override
  Widget build(BuildContext context) {
    final h = spot.session;
    return Tappable(
      onTap: () => workbenchGo(context, '/issues/${Uri.encodeComponent(h.id)}'),
      semanticLabel: '${h.name}：${phaseText(h, now)}',
      builder: (context, st) => Container(
        decoration: BoxDecoration(color: st.hovered ? ProColor.hover : null, borderRadius: proRadius),
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
        child: Row(
          children: [
            AgentFaceOf(h.agent, size: 32),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(h.name, style: ProText.sm.copyWith(fontWeight: FontWeight.w500)),
                  Text(phaseText(h, now), style: ProText.meta, maxLines: 2, overflow: TextOverflow.ellipsis),
                  if (h.branch case final branch?)
                    Row(
                      children: [
                        const SpriteIcon('icon-branch', size: 14),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            branch,
                            style: ProText.mono.copyWith(fontSize: 12, color: ProColor.muted),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            SpriteIcon(cropSprite(spot.plot.crop), size: 32),
          ],
        ),
      ),
    );
  }
}
