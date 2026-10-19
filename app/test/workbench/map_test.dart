import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:vibevalley/audio/sfx.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/workbench/projects/projects_page.dart';
import 'package:vibevalley/workbench/map/map_rules.dart';
import 'package:vibevalley/shared/swatches.dart' show Pose;
import 'package:vibevalley/gen/vibevalley.dart';

import '../support/farm.dart';

const _working = PhaseWorking(
  since: 0,
  doing: Doing(action: SessionAction.editFile, label: 'src/a.ts'),
);

ProjectSummary _project(String name, {double? last, double slots = 3}) => ProjectSummary(
  pullRequest: const PullRequestCapability(available: false, reason: "尚未检测 GitHub"),
  name: name,
  path: "/work/$name",
  git: true,
  last: last,
  slots: slots,
);

Issue _todo(String id, String project, {double? queuedAt}) => Issue(
  id: id,
  number: 1,
  title: '活 $id',
  project: project,
  priority: Priority.medium,
  createdAt: 0,
  queuedAt: queuedAt,
  sessions: const [],
  status: queuedAt == null ? IssueStatus.backlog : IssueStatus.todo,
  moves: [],
  acceptance: Acceptance.glance,
  findings: [],
  asks: [],
);

Session _hired(String id, String? project, Phase phase, {double at = 0, Conflict? conflict, String? branch, String? name}) {
  final h = session(id, name: name ?? '帮工$id', project: project, phase: phase, conflict: conflict, branch: branch);
  return Session(
    id: h.id,
    name: h.name,
    agent: h.agent,
    runtime: h.runtime,
    brief: h.brief,
    project: h.project,
    branch: h.branch,
    conflict: h.conflict,
    hiredAt: at,
    runs: h.runs,
    phase: h.phase,
    issue: h.issue,
  );
}

List<String> _kinds(Island i) => [
  for (final s in i.spots)
    switch (s) {
      SpotTaken(:final session) => session.id,
      SpotOpen() => 'open',
      SpotShut() => 'shut',
    },
];

void main() {
  group('islands', () {
    final projects = [_project('clock-in', last: 9), _project('docs', last: 5), _project('task-smoke', last: 7)];

    test('worktrees in the order the helpers came, then the room the project and the farm leave', () {
      final islands = islandsOf(
        projects: projects,
        sessions: [
          _hired('w2', 'clock-in', const PhaseRipe(), at: 2),
          _hired('w1', 'clock-in', _working, at: 1),
          _hired('w4', 'clock-in', const PhaseResting(), at: 4),
          _hired('w5', 'docs', _working),
          _hired('w3', null, const PhaseFailed()),
        ],
        plots: const {'tw1': PlotView(crop: Crop.leafy)},
        issues: [_todo('b2', 'docs', queuedAt: 8), _todo('b1', 'docs', queuedAt: 3), _todo('b3', 'clock-in')],
      );
      expect([for (final i in islands) i.project], ['clock-in', 'docs', 'task-smoke']);
      final clock = islands.first;
      expect(_kinds(clock), ['w1', 'w2', 'w4', 'open', 'open']);
      expect((clock.working, clock.slots, clock.open), (1, 3, 2));
      expect((clock.spots.first as SpotTaken).plot.crop, Crop.leafy);
      expect((clock.spots[1] as SpotTaken).plot.crop, Crop.seeded, reason: 'no plot in the view yet');
      expect(islandText(clock), '在干 1/3');
      expect([for (final b in islands[1].queued) b.id], ['b1', 'b2']);
      expect(islandText(islands[1]), '在干 1/3 · 排队 2');
      expect(_kinds(islands[2]), ['open', 'open', 'open']);
      expect(
        [
          for (final h in homeless([..._sessionsOf(islands), _hired('w3', null, const PhaseFailed())])) h.id,
        ],
        ['w3'],
      );
      expect(mapTally(islands), (peopled: 2, working: 2, queued: 2));
    });

    test('a full project has no room; when every bed is working, its slots are shut', () {
      final full = islandsOf(
        projects: projects,
        sessions: [
          for (final id in ['a', 'b', 'c']) _hired(id, 'clock-in', _working),
        ],
        plots: const {},
        issues: const [],
      ).first;
      expect(_kinds(full), ['a', 'b', 'c']);
      expect(full.full, isTrue);
      expect(islandText(full), '在干 3/3（满了）');

      final busyFarm = islandsOf(
        projects: projects,
        sessions: [for (var i = 0; i < 6; i++) _hired('h$i', i.isEven ? 'clock-in' : 'docs', _working)],
        plots: const {},
        issues: const [],
      );
      expect(_kinds(busyFarm.firstWhere((i) => i.project == 'task-smoke')), ['shut', 'shut', 'shut']);
    });

    test('a project gone from the list keeps its helpers and takes no more', () {
      final gone = islandsOf(projects: const [], sessions: [_hired('w1', 'old', const PhaseRipe())], plots: const {}, issues: const []).single;
      expect(gone.summary, isNull);
      expect(_kinds(gone), ['w1']);
      expect(islandText(gone), '不在工作目录里了');
    });

    test('a yard holds six plots at most', () {
      final crowded = islandsOf(
        projects: [_project('big', slots: 6)],
        sessions: [for (var i = 0; i < 5; i++) _hired('r$i', 'big', const PhaseResting())],
        plots: const {},
        issues: const [],
      ).single;
      expect(crowded.spots, hasLength(maxRunning));
      expect(_kinds(crowded).last, 'open');
    });
  });

  group('the yard', () {
    const yard = Rect.fromLTWH(100, 50, 150, 80);

    test('three plots side by side, centred; four as two and two; five as three and two', () {
      final three = plotsIn(yard, 3);
      expect([for (final p in three) p.dx], [121, 175, 229]);
      expect(three.map((p) => p.dy).toSet(), hasLength(1));
      final four = plotsIn(yard, 4);
      expect([for (final p in four) p.dx], [148, 202, 148, 202]);
      expect(four[2].dy - four[0].dy, 36);
      final five = plotsIn(yard, 5);
      expect([for (final p in five.skip(3)) p.dx], [148, 202]);
      for (final p in [...three, ...four, ...five]) {
        expect(p.dx - 17 >= yard.left && p.dx + 17 <= yard.right, isTrue, reason: '$p inside the yard');
      }
      expect(plotsIn(yard, 0), isEmpty);
      expect(plotsIn(yard, 1).single, Offset(yard.center.dx, plotsIn(yard, 1).single.dy));
    });

    test('islands twice as big two to a row, smaller to fit two, one to a row on a narrow page', () {
      expect(islandScale(1340, 292, 24), 2);
      expect(islandScale(940, 292, 24), 1.5);
      expect(islandScale(800, 292, 24), 2.5);
      expect(islandScale(500, 292, 24), 1.5);
      expect(islandScale(326, 292, 24), closeTo(1.116, 1e-3));
    });

    test('how a helper looks on its plot', () {
      expect(mapPose(_hired('a', 'p', _working)), Pose.work);
      expect(
        mapPose(
          _hired(
            'a',
            'p',
            const PhaseWorking(
              since: 0,
              doing: Doing(action: SessionAction.thinking, label: ''),
            ),
          ),
        ),
        Pose.think,
      );
      expect(mapPose(_hired('a', 'p', const PhaseRipe())), Pose.cheer);
      expect(mapPose(_hired('a', 'p', const PhaseFailed())), Pose.worry);
      expect(
        mapPose(
          _hired(
            'a',
            'p',
            const PhaseResting(),
            conflict: const Conflict(base: 'main', files: ['a.ts']),
          ),
        ),
        Pose.worry,
      );
      expect(mapPose(_hired('a', 'p', const PhaseResting())), Pose.idle);
    });

    test("a project's island is the same every time, and every one is drawn with its yard", () {
      expect(islandLook('clock-in'), islandLook('clock-in'));
      expect(
        {
          for (final p in ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'clock-in', 'docs']) islandLook(p),
        }.length,
        greaterThan(2),
      );
      for (final look in islandLooks) {
        final yard = atlas[look].yard!;
        expect(yard.width, closeTo(150, 1), reason: look);
        expect(yard.height, greaterThan(55), reason: look);
        expect(Rect.fromLTWH(0, 0, atlas[look].w, atlas[look].h).contains(yard.bottomRight - const Offset(1, 1)), isTrue, reason: look);
      }
    });
  });

  testWidgets('the map: islands and their plots; a free plot starts an issue there, a helper opens its own, an island its worktrees', (t) async {
    final handle = t.ensureSemantics();
    Sfx.setMuted(true);
    addTearDown(() => Sfx.setMuted(false));
    final now = DateTime.now().millisecondsSinceEpoch;
    final routes = Routes();
    final api = fakeApi(routes, {
      'GET /api/v1/projects': [
        {
          'pullRequest': {'available': false, 'reason': '没装 gh'},
          'name': 'clock-in',
          'path': '/work/clock-in',
          'git': true,
          'last': now - 3600000,
          'slots': 3,
        },
        {
          'pullRequest': {'available': false, 'reason': '没装 gh'},
          'name': 'docs',
          'path': '/work/docs',
          'git': true,
          'last': now - 3 * 86400000,
          'slots': 3,
        },
        {
          'pullRequest': {'available': false, 'reason': '没装 gh'},
          'name': 'task-smoke',
          'path': '/work/task-smoke',
          'git': false,
          'slots': 2,
        },
      ],
      'GET /api/v1/projects/task-smoke/templates': const ProjectTemplates(
        project: 'task-smoke',
        stack: ProjectStack(name: 'go', label: 'Go', test: 'go test ./...'),
        recent: [],
        kinds: [],
      ).toJson(),
      'POST /api/v1/issues/b1/dispatch': const Dispatched(session: 's9').toJson(),
    });
    final state = farm(
      sessions: [
        _hired('w1', 'clock-in', _working, branch: 'vibevalley/w1-tests', name: '测试小吴'),
        _hired('w2', 'clock-in', const PhaseRipe(), at: 1, branch: 'vibevalley/w2-makeup'),
        _hired('w5', 'docs', _working),
      ],
      issues: [
        const Issue(
          id: 'b1',
          number: 1,
          title: '写周报',
          project: 'docs',
          priority: Priority.medium,
          createdAt: 0,
          queuedAt: 5,
          sessions: [],
          status: IssueStatus.todo,
          moves: [],
          acceptance: Acceptance.glance,
          findings: [],
          asks: [],
        ),
      ],
    );
    final went = <String>[];
    final router = GoRouter(
      initialLocation: '/projects',
      routes: [
        GoRoute(
          path: '/projects',
          builder: (_, _) => const Scaffold(body: ProjectsPage()),
        ),
        GoRoute(
          path: '/projects/:project',
          builder: (_, s) => Scaffold(body: ProjectsPage(id: s.pathParameters['project'])),
        ),
        for (final path in ['/issues/:id'])
          GoRoute(
            path: path,
            builder: (_, s) {
              went.add(s.uri.toString());
              return const SizedBox();
            },
          ),
      ],
    );
    t.view.physicalSize = const Size(1440, 1400);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final container = ProviderContainer(
      overrides: [
        ...overrides(
          state,
          view(
            plots: const {
              'tw1': PlotView(crop: Crop.leafy),
              'tw2': PlotView(
                crop: Crop.wheat,
                badge: PlotViewBadge(text: '可收获', tone: BadgeTone.ripe),
              ),
            },
          ),
          api,
        ),
        atlasProvider.overrideWith((ref) async => atlas),
      ],
    );
    addTearDown(container.dispose);
    await t.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(theme: farmTheme(), routerConfig: router),
      ),
    );
    await settle(t);

    // In the list, and as its island on the map.
    expect(find.text('clock-in'), findsNWidgets(2));
    expect(find.text('在干 1/3'), findsOneWidget);
    expect(find.text('在干 1/3 · 排队 1'), findsOneWidget);
    expect(find.text('在干 0/2'), findsOneWidget);
    for (final piece in ['3 座岛 · ', '2 座有人 · ', '在干 2/6 块地 · ', '排队 1']) {
      expect(find.text(piece), findsOneWidget);
    }
    expect(find.text('可收获'), findsOneWidget);

    // Already inside the island's place: the bag sows there, with no project to choose and no farm bed.
    await t.tap(find.bySemanticsLabel('空位，派一件活到 task-smoke').first);
    await settle(t);
    expect(went, isEmpty, reason: 'the bag opens on the map, not the new-issue page');
    expect(find.text('播种 · task-smoke'), findsOneWidget);
    expect(find.text('种在 task-smoke'), findsOneWidget);
    expect(find.text('种在哪个项目？'), findsNothing);
    expect(find.text('换个项目'), findsOneWidget, reason: 'still there for the owner who meant another one');
    await t.enterText(find.descendant(of: find.bySemanticsLabel('工单'), matching: find.byType(EditableText)), '补上冒烟测试');
    await t.pump();
    await t.ensureVisible(find.text('播种').last);
    await t.tap(find.text('播种').last);
    await settle(t);
    expect(routes.named('POST', '/api/v1/say').single.body, {'text': '补上冒烟测试', 'project': 'task-smoke', 'sendKey': matches(RegExp(r'^[0-9a-f]{32}$'))});
    await t.pump(const Duration(milliseconds: 200));
    expect(find.text('播种 · task-smoke'), findsNothing, reason: 'sown: the bag closes');

    // A queued todo starts from the bag on the island too, without a bed.
    await t.tap(find.bySemanticsLabel('空位，派一件活到 docs').first);
    await settle(t);
    await t.tap(find.text('开工待办 1'));
    await settle(t);
    await t.tap(find.text('开工'));
    await settle(t);
    expect(routes.named('POST', '/api/v1/issues/b1/dispatch').single.body, isEmpty);
    await t.pump(const Duration(milliseconds: 200));
    expect(find.text('播种 · docs'), findsNothing);

    router.go('/projects');
    await settle(t);
    await t.tap(find.bySemanticsLabel('测试小吴'));
    await settle(t);
    expect(went.last, '/issues/w1');

    router.go('/projects');
    await settle(t);
    // The island, not its row in the list.
    await t.tap(find.text('docs').last);
    await settle(t);
    expect(router.routerDelegate.currentConfiguration.uri.toString(), '/projects/docs');
    expect(find.text('worktree · 1 个'), findsOneWidget);
    expect(find.text('排队 · 1 件'), findsOneWidget);
    expect(find.text('写周报'), findsOneWidget);
    expect(find.textContaining('还能再派 2 件活'), findsOneWidget);

    await t.pumpWidget(const SizedBox());
    handle.dispose();
  });
}

Iterable<Session> _sessionsOf(List<Island> islands) => islands.expand((i) => i.sessions);
