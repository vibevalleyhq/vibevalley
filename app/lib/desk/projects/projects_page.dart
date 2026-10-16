import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../sprites/atlas.dart';
import '../../ui/kit/kit.dart';
import '../runtimes/layout.dart';
import '../shared/faces.dart';
import '../shared/state.dart';
import 'codebase.dart';
import 'new_project_dialog.dart';
import 'projects_state.dart';
import '../shared/widgets.dart';

class ProjectsPage extends ConsumerStatefulWidget {
  const ProjectsPage({super.key, this.id});
  final String? id;

  @override
  ConsumerState<ProjectsPage> createState() => _ProjectsPageState();
}

class _ProjectsPageState extends ConsumerState<ProjectsPage> {
  /// A minute at a time: enough for 「3 小时前」.
  DateTime _now = DateTime.now();
  Timer? _clock;

  @override
  void initState() {
    super.initState();
    unawaited(ref.read(projectsProvider.notifier).load().catchError((Object _) {}));
    _clock = Timer.periodic(const Duration(minutes: 1), (_) => setState(() => _now = DateTime.now()));
  }

  @override
  void dispose() {
    _clock?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(projectsProvider);
    final atlas = ref.watch(atlasProvider).value;
    final list = state.list;
    final sorted = sortProjects(list ?? const []);
    final selected = sorted.where((p) => p.name == widget.id).firstOrNull ?? sorted.firstOrNull;
    final survey = selected == null ? null : state.surveys[selected.name];
    if (selected != null && survey == null) {
      // Asked once per project: the survey's first answer (or refusal) stays until 统计 asks again.
      final name = selected.name;
      Future.microtask(() {
        if (mounted && ref.read(projectsProvider).surveys[name] == null) unawaited(ref.read(projectsProvider.notifier).survey(name));
      });
    }
    final now = _now.millisecondsSinceEpoch.toDouble();
    if (atlas == null) return const SizedBox.shrink();
    return ListDetail(
      list: ListCard(
        title: '项目',
        subtitle: '代码库',
        semanticLabel: '项目列表',
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: PxButton(
              onPressed: () => showNewProjectDialog(context),
              child: const Row(mainAxisSize: MainAxisSize.min, children: [SpriteIcon('button-add', size: 16), SizedBox(width: 6), Text('新增项目')]),
            ),
          ),
          if (list == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              child: Text('在找……', style: KitText.sm.copyWith(color: Palette.bark500)),
            )
          else if (sorted.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
              child: Text('工作目录下还没有项目。点「新增项目」开一块地，或从 GitHub 下载一个。', style: KitText.sm.copyWith(color: Palette.bark600, height: 1.625)),
            )
          else
            for (final p in sorted)
              ListRow(
                active: p.name == selected?.name,
                onTap: () => deskGo(context, '/projects/${Uri.encodeComponent(p.name)}'),
                child: _ProjectRow(project: p, now: now),
              ),
        ],
      ),
      detail: selected == null
          ? [if (list != null) const PxCard(child: Text('工作目录下还没有项目。'))]
          : [
              _Deed(project: selected, survey: survey, now: now),
              _Planted(counted: survey?.languages),
              _TillingCalendar(activity: survey?.activity, now: _now),
              _Hands(atlas: atlas, activity: survey?.activity),
            ],
    );
  }
}

String since(double at, double now) {
  final minutes = (now - at) / 60000 < 0 ? 0.0 : (now - at) / 60000;
  if (minutes < 2) return '刚刚';
  if (minutes < 60) return '${minutes.round()} 分钟前';
  final hours = minutes / 60;
  if (hours < 24) return '${hours.round()} 小时前';
  final days = hours / 24;
  if (days < 45) return '${days.round()} 天前';
  if (days < 365) return '${(days / 30).round()} 个月前';
  return '${(days / 365).toStringAsFixed(1)} 年前';
}

String _dateText(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.year} 年 ${d.month} 月 ${d.day} 日';
}

const _weekday = ['一', '二', '三', '四', '五', '六', '日'];
String _dayText(DateTime d) => '${d.month} 月 ${d.day} 日 星期${_weekday[d.weekday - 1]}';

/// As toLocaleString('zh-CN') writes it: 「12,345」.
String number(num n) {
  final whole = n.round().abs().toString();
  final out = StringBuffer(n < 0 ? '-' : '');
  for (var i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 == 0) out.write(',');
    out.write(whole[i]);
  }
  return out.toString();
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.project, required this.now});
  final ProjectSummary project;
  final double now;

  @override
  Widget build(BuildContext context) {
    final growth = growthOf(project.last, now);
    final line = !project.git
        ? '还不是 git 仓库'
        : project.last != null
        ? '${growth.label} · ${since(project.last!, now)}'
        : growth.label;
    return Row(
      children: [
        SpriteIcon('plot-${growth.crop}', size: 40),
        const SizedBox(width: 10),
        Expanded(child: RowText(project.name, line)),
      ],
    );
  }
}

class _Deed extends ConsumerWidget {
  const _Deed({required this.project, required this.survey, required this.now});
  final ProjectSummary project;
  final Survey? survey;
  final double now;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final growth = growthOf(project.last, now);
    final languages = survey?.languages;
    final activity = survey?.activity;
    final counted = languages is Done<ProjectLanguages> ? languages.value : null;
    final worked = activity is Done<ProjectActivity> ? activity.value : null;
    final lines = counted?.languages.fold<double>(0, (n, l) => n + l.code + l.comments);
    final crops = counted == null ? null : languageShares(counted.languages, top: null).length;
    final busy = languages is Asking || activity is Asking;
    final notCounted = languages is Failed;
    return PxWindow(
      paper: Palette.cream50,
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          Container(
            width: 96,
            height: 96,
            alignment: Alignment.center,
            color: Palette.cream100,
            foregroundDecoration: pxRing,
            child: SpriteIcon('plot-${growth.crop}', size: 80, semanticLabel: '长势：${growth.label}'),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Wrap(
                  spacing: 12,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(project.name, style: KitText.x2l, maxLines: 1, overflow: TextOverflow.ellipsis),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                      color: Palette.leaf300.withValues(alpha: .5),
                      child: Text('长势 · ${growth.label}', style: KitText.xs.copyWith(color: Palette.bark800)),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final (i, stat) in [
                      _Stat('开垦于', worked?.first != null ? _dateText(worked!.first!) : (worked != null ? '还没动过土' : '…')),
                      _Stat('耕作', worked != null ? '${number(worked.total)} 次提交' : '…'),
                      _Stat('庄稼', lines != null ? '${number(lines)} 行' : (notCounted ? '没数' : '…')),
                      _Stat('种了', crops != null ? '$crops 样' : (notCounted ? '没数' : '…')),
                    ].indexed) ...[if (i > 0) const SizedBox(width: 24), Expanded(child: stat)],
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    const SpriteIcon('button-folder', size: 14),
                    const SizedBox(width: 6),
                    Flexible(
                      child: SelectableText(project.path, maxLines: 1, style: KitText.mono.copyWith(fontSize: 11, color: Palette.bark600)),
                    ),
                    const SizedBox(width: 4),
                    PxButton(
                      size: PxSize.icon,
                      tooltip: '复制路径',
                      semanticLabel: '复制路径',
                      onPressed: () {
                        unawaited(Clipboard.setData(ClipboardData(text: project.path)));
                        toasts.add(type: ToastType.info, title: '复制好了', description: project.path);
                      },
                      child: const SpriteIcon('button-copy', size: 14),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
              PxButton(
                size: PxSize.icon,
                tooltip: busy ? '在数……' : '重新统计',
                semanticLabel: '重新统计',
                onPressed: busy ? null : () => ref.read(projectsProvider.notifier).survey(project.name),
                child: const SpriteIcon('button-refresh', size: 16),
              ),
              if (counted != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text('${since(counted.at, now)}数过', style: KitText.fine.copyWith(color: Palette.bark500)),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(label, style: KitText.fine.copyWith(color: Palette.bark500)),
      Text(value, style: KitText.sm, maxLines: 1, overflow: TextOverflow.ellipsis),
    ],
  );
}

const _logoInBed = 0.07;

String percent(double share) => share >= 0.1 ? '${(share * 100).round()}%' : '${(share * 100).toStringAsFixed(1)}%';

class _Planted extends StatelessWidget {
  const _Planted({required this.counted});
  final Asked<ProjectLanguages>? counted;

  @override
  Widget build(BuildContext context) {
    final c = counted;
    final shares = c is Done<ProjectLanguages> ? languageShares(c.value.languages) : const <LanguageShare>[];
    final Widget body;
    if (c == null || c is Asking<ProjectLanguages>) {
      body = Container(height: 48, color: Palette.cream200);
    } else if (c is Failed<ProjectLanguages>) {
      body = _NotCounted(reason: c.reason);
    } else if (shares.isEmpty) {
      body = Text('这块地还空着：没有数得出来的代码。', style: KitText.sm.copyWith(color: Palette.bark600));
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Semantics(
            image: true,
            label: shares.map((s) => '${s.label} ${percent(s.share)}').join('，'),
            child: Container(
              height: 56,
              padding: const EdgeInsets.all(4),
              color: const Color(0xFF7A5A3A),
              foregroundDecoration: pxRing,
              child: Row(
                children: [
                  for (final s in shares)
                    Expanded(
                      flex: (s.share * 10000).round().clamp(1, 10000),
                      child: Tooltip(
                        message: '${s.label} · ${percent(s.share)}',
                        child: Container(
                          constraints: const BoxConstraints(minWidth: 4),
                          color: s.color,
                          alignment: Alignment.center,
                          child: s.share >= _logoInBed ? SpriteIcon(langIcon(s.id), size: 36) : null,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Cols(columns: 2, from: 640, gap: 24, rowGap: 8, children: [for (final s in shares) _Crop(share: s)]),
        ],
      );
    }
    return PxCard(title: '种了什么', aside: const Text('按行数，不算空行 · tokei 数的'), child: body);
  }
}

class _Crop extends StatelessWidget {
  const _Crop({required this.share});
  final LanguageShare share;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      SpriteIcon(langIcon(share.id), size: 32),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(share.label, style: KitText.sm, maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
                Text(percent(share.share), style: KitText.sm.copyWith(color: Palette.bark800)),
              ],
            ),
            const SizedBox(height: 4),
            Container(
              height: 6,
              color: Palette.cream200,
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                widthFactor: (share.share < 0.02 ? 0.02 : share.share).clamp(0.0, 1.0),
                child: Container(color: share.color),
              ),
            ),
            const SizedBox(height: 2),
            Text('${number(share.lines)} 行 · ${number(share.files)} 个文件', style: KitText.fine.copyWith(color: Palette.bark500)),
          ],
        ),
      ),
    ],
  );
}

class _NotCounted extends StatelessWidget {
  const _NotCounted({required this.reason});
  final String reason;

  @override
  Widget build(BuildContext context) {
    final install = reason.contains('brew install tokei');
    Widget code(String t) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      color: Palette.cream200,
      child: Text(t, style: KitText.mono),
    );
    return Container(
      padding: const EdgeInsets.all(12),
      color: Palette.cream100,
      foregroundDecoration: pxRing,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(install ? '数庄稼要用 tokei，这台机器上还没有。' : reason, style: KitText.sm.copyWith(color: Palette.bark800)),
          if (install) ...[
            const SizedBox(height: 8),
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              runSpacing: 4,
              children: [
                Text('在终端里装一个：', style: KitText.sm.copyWith(color: Palette.bark600)),
                code('brew install tokei'),
                Text('（或 ', style: KitText.sm.copyWith(color: Palette.bark600)),
                code('cargo install tokei'),
                Text('），装好点上面的「统计」。', style: KitText.sm.copyWith(color: Palette.bark600)),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// Its tile is `day-<level>`.
const _levelName = ['空地', '撒了种', '发了芽', '长了叶', '开了花'];

const _gap = 3.0;
const _labels = 20.0;
const _tile = 12.0;

class _TillingCalendar extends StatefulWidget {
  const _TillingCalendar({required this.activity, required this.now});
  final Asked<ProjectActivity>? activity;
  final DateTime now;

  @override
  State<_TillingCalendar> createState() => _TillingCalendarState();
}

class _TillingCalendarState extends State<_TillingCalendar> {
  CalendarDay? _pointed;
  Calendar? _calendar;
  Streaks? _streaks;
  Object? _from;

  @override
  Widget build(BuildContext context) {
    final activity = widget.activity;
    if (activity is Failed<ProjectActivity>) {
      return PxCard(
        title: '耕作日历',
        aside: const Text('过去一年 · 一格一天，提交越多长得越高'),
        child: Text(activity.reason, style: KitText.sm.copyWith(color: Palette.bark800)),
      );
    }
    final worked = activity is Done<ProjectActivity> ? activity.value : null;
    final key = (worked, widget.now);
    if (_from != key) {
      _from = key;
      _calendar = calendarOf(worked?.days ?? const [], widget.now);
      _streaks = streaksOf(_calendar!);
    }
    final calendar = _calendar!;
    final streaks = _streaks!;
    final muted = KitText.xs.copyWith(color: Palette.bark500);
    final pointed = _pointed;
    final busiest = streaks.busiest;
    final line = pointed != null && !pointed.future
        ? '${_dayText(pointed.at)} · ${pointed.commits > 0 ? '${pointed.commits} 次提交，${_levelName[pointed.level]}' : '没动土'}'
        : busiest != null
        ? '最忙的一天：${_dayText(DateTime.parse('${busiest.day}T12:00'))}，${busiest.commits} 次提交'
        : ' ';
    return PxCard(
      title: '耕作日历',
      aside: const Text('过去一年 · 一格一天，提交越多长得越高'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final (i, stat) in [
                _Stat('一年里', worked != null ? '${number(streaks.total)} 次提交' : '…'),
                _Stat('动过土的日子', worked != null ? '${streaks.days} 天' : '…'),
                _Stat('最长连着干', worked != null ? '${streaks.longest} 天' : '…'),
                _Stat('最近连着干', worked != null ? '${streaks.current} 天' : '…'),
              ].indexed) ...[if (i > 0) const SizedBox(width: 24), Expanded(child: stat)],
            ],
          ),
          const SizedBox(height: 16),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.only(bottom: 4),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minWidth: 704),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    height: 16,
                    width: _labels + calendar.weeks.length * (_tile + _gap),
                    child: Stack(
                      children: [
                        for (final m in calendar.months)
                          Positioned(
                            left: _labels + _gap + m.week * (_tile + _gap),
                            top: 0,
                            child: Text(m.label, style: muted),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 4),
                  Semantics(
                    image: true,
                    label: worked != null ? '过去一年 ${streaks.total} 次提交，${streaks.days} 天动过土' : '在读提交',
                    child: MouseRegion(
                      onExit: (_) => setState(() => _pointed = null),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: _labels,
                            child: Column(
                              children: [
                                for (final (i, d) in const ['', '一', '', '三', '', '五', ''].indexed)
                                  Container(
                                    height: _tile,
                                    margin: EdgeInsets.only(top: i == 0 ? 0 : _gap),
                                    alignment: Alignment.centerLeft,
                                    child: Text(d, style: muted.copyWith(fontSize: 10, height: 1)),
                                  ),
                              ],
                            ),
                          ),
                          for (final week in calendar.weeks)
                            Padding(
                              padding: const EdgeInsets.only(left: _gap),
                              child: Column(
                                children: [
                                  for (final (i, d) in week.indexed)
                                    Padding(
                                      padding: EdgeInsets.only(top: i == 0 ? 0 : _gap),
                                      child: MouseRegion(
                                        onEnter: (_) => setState(() => _pointed = d),
                                        child: Opacity(
                                          opacity: d.future ? 0 : (worked != null ? 1 : .5),
                                          child: SpriteIcon('day-${d.level}', size: _tile),
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              Text(line, style: KitText.xs.copyWith(color: Palette.bark600)),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('少', style: KitText.xs.copyWith(color: Palette.bark600)),
                  for (var l = 0; l <= 4; l++)
                    Padding(
                      padding: const EdgeInsets.only(left: 4),
                      child: Tooltip(
                        message: _levelName[l],
                        child: SpriteIcon('day-$l', size: _tile),
                      ),
                    ),
                  const SizedBox(width: 4),
                  Text('多', style: KitText.xs.copyWith(color: Palette.bark600)),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}

const _hands = 8;

class _Hands extends ConsumerWidget {
  const _Hands({required this.atlas, required this.activity});
  final SpriteAtlas atlas;
  final Asked<ProjectActivity>? activity;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = activity;
    final authors = a is Done<ProjectActivity> ? a.value.authors : const <Author>[];
    if (authors.isEmpty) return const SizedBox.shrink();
    final agents = ref.watch(deskConfigProvider).agents;
    final top = authors.first.commits > 0 ? authors.first.commits : 1;
    final rest = authors.skip(_hands).fold<double>(0, (n, x) => n + x.commits);
    return PxCard(
      title: '谁来干过活',
      aside: const Text('过去一年的提交'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Cols(
            columns: 2,
            from: 640,
            gap: 10,
            children: [
              for (final author in authors.take(_hands))
                Row(
                  children: [
                    if (agents.where((x) => x.name == author.name).firstOrNull case final agent?)
                      AgentFace(look: agent.look, id: agent.id, size: 32)
                    else
                      Container(
                        width: 32,
                        height: 32,
                        alignment: Alignment.center,
                        color: Palette.cream200,
                        child: Text(author.name.characters.firstOrNull ?? '', style: KitText.sm.copyWith(color: Palette.bark800)),
                      ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(author.name, style: KitText.sm, maxLines: 1, overflow: TextOverflow.ellipsis),
                              ),
                              Text('${number(author.commits)} 次', style: KitText.xs.copyWith(color: Palette.bark600)),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Container(
                            height: 6,
                            color: Palette.cream200,
                            alignment: Alignment.centerLeft,
                            child: FractionallySizedBox(
                              widthFactor: (author.commits / top).clamp(0.0, 1.0),
                              child: Container(color: Palette.leaf500),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
            ],
          ),
          if (rest > 0)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('还有 ${authors.length - _hands} 位，一共 ${number(rest)} 次。', style: KitText.xs.copyWith(color: Palette.bark500)),
            ),
        ],
      ),
    );
  }
}
