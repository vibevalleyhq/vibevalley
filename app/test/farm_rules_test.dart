// The farm's rules as the client keeps them (game/farm.dart, rules/): what each tool would do to a bed, the
// seed bag, the cursor's name, and the protocol functions ported to Dart (needs, phase words, playbook layers and
// events, progress standing).

import 'package:flutter_test/flutter_test.dart' hide Retry;
import 'package:vibevalley/farm/cursors.dart';
import 'package:vibevalley/game/farm.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'farm_fakes.dart';
import 'package:vibevalley/rules/farm.dart';
import 'package:vibevalley/rules/index.dart';
import 'package:vibevalley/rules/playbook.dart';
import 'package:vibevalley/rules/progress.dart';

void main() {
  const empty = PlotView(crop: Crop.empty);
  final bed0 = beds[0];
  final locked = beds[6];

  test('aimTool: the hand plants an empty bed and looks at a worked one; a locked bed says when it opens', () {
    expect(aimTool(Tool.hand, bed0, null, empty, 1).text, '播种');
    expect(aimTool(Tool.hand, bed0, helper('w1'), empty, 1).text, '看看这块地');
    final lockedAim = aimTool(Tool.hand, locked, null, empty, 1);
    expect((lockedAim.ok, lockedAim.text), (false, 'Lv.5 开垦这块地'));
    expect(aimTool(Tool.hand, locked, null, empty, 5).text, '开垦好的花坛');
  });

  test('aimTool: water needs a helper, bug a withered plot, harvest a finished turn not in a playbook, shovel stops or dismisses', () {
    final w = helper('w1', name: '小吴');
    expect(aimTool(Tool.water, bed0, w, empty, 1).text, '给小吴浇水（带句话）');
    expect(aimTool(Tool.water, bed0, null, empty, 1).ok, isFalse);
    expect(aimTool(Tool.bug, bed0, w, const PlotView(crop: Crop.withered), 1).ok, isTrue);
    expect(aimTool(Tool.bug, bed0, w, empty, 1).text, '这块地没有虫');
    expect(aimTool(Tool.weed, bed0, w, const PlotView(crop: Crop.weeds), 1).text, '批准还没接上');
    final ripe = helper('w2', phase: const PhaseRipe());
    expect(aimTool(Tool.harvest, bed0, ripe, const PlotView(crop: Crop.wheat), 1).text, '收获，帮工收工');
    expect(aimTool(Tool.harvest, bed0, helper('w3', phase: const PhaseResting()), empty, 1).text, '收获：看看它改了什么');
    expect(aimTool(Tool.harvest, bed0, w, empty, 1).text, '还没熟，等它做完');
    expect(
      aimTool(
        Tool.harvest,
        bed0,
        helper(
          'w4',
          phase: const PhaseRipe(),
          playbook: const HelperPlaybook(id: 'p1'),
        ),
        empty,
        1,
      ).ok,
      isFalse,
    );
    expect(aimTool(Tool.shovel, bed0, w, empty, 1).text, '铲除：叫停');
    expect(aimTool(Tool.shovel, bed0, ripe, empty, 1).text, '铲除：请它收工');
    expect(aimTool(Tool.shovel, bed0, null, empty, 1).ok, isFalse);
  });

  test('bugText does not stack its own words', () {
    expect(bugText('修登录'), '接着修：修登录。看一下报错，修好再跑一遍测试');
    expect(bugText(bugText('修登录')), '接着修：修登录。看一下报错，修好再跑一遍测试');
  });

  test('seedsFor: past jobs first, each once and short, then jobs for projects, then any; eight at most', () {
    final seeds = seedsFor(['修登录', '修登录', 'x' * 61], ['clock-in']);
    expect(seeds.first, '修登录');
    expect(seeds.where((s) => s == '修登录'), hasLength(1));
    expect(seeds, isNot(contains('x' * 61)));
    expect(seeds[1], '看看 clock-in 的测试有没有挂，挂了就修');
    expect(seeds, hasLength(seedCount));
  });

  test('stageCursor: the tool, its ok, no and press forms; the glove over a thing in the yard', () {
    expect(stageCursor(tool: Tool.water, aim: null, overSpot: false, pressed: false), 'water');
    expect(stageCursor(tool: Tool.water, aim: null, overSpot: true, pressed: false), 'hand-point');
    expect(stageCursor(tool: Tool.water, aim: const Aim(true, ''), overSpot: false, pressed: false), 'water-ok');
    expect(stageCursor(tool: Tool.water, aim: const Aim(true, ''), overSpot: false, pressed: true), 'water-press');
    expect(stageCursor(tool: Tool.bug, aim: const Aim(false, ''), overSpot: false, pressed: false), 'bug-no');
    expect(stageCursor(tool: Tool.hand, aim: const Aim(true, ''), overSpot: false, pressed: true), 'hand-press');
  });

  test('needOf and phaseText say what is asked of you', () {
    final quiet = helper(
      'w1',
      phase: const PhaseWorking(
        since: 0,
        doing: Doing(action: WorkerAction.runCommand, label: 'pnpm test'),
        quietSince: 1000,
      ),
    );
    expect(needOf(quiet), isA<NeedQuiet>());
    expect(phaseText(quiet, 1000 + 120000), '在跑命令：pnpm test（已经 2 分钟没动静了）');
    final retrying = helper(
      'w2',
      phase: const PhaseWorking(
        since: 0,
        doing: Doing(action: WorkerAction.thinking, label: ''),
        retry: Retry(attempt: 2, of: 5),
      ),
    );
    expect(phaseText(retrying, 0), '在思考（模型调用失败，在重试第 2/5 次）');
    final conflicted = helper(
      'w3',
      phase: const PhaseRipe(),
      conflict: const Conflict(base: 'main', files: ['a.ts']),
    );
    expect(needOf(conflicted), isA<NeedConflict>());
    expect(phaseText(conflicted, 0), '这一轮做完了，等收获，合进 main 会冲突（a.ts）');
    expect(
      phaseText(
        helper(
          'w4',
          phase: const PhaseResting(),
          last: const LastTurn(outcome: Outcome.interrupted, summary: '', at: 0),
        ),
        0,
      ),
      '歇着（上一轮被叫停）',
    );
    expect(spentText(const Spent(tokens: 26000, cny: 0.03)), '约 ¥0.03 · 2.6 万 token');
  });

  PlaybookNode node(String id, {List<String> needs = const [], NodeState state = NodeState.waiting}) =>
      PlaybookNode(id: id, title: id.toUpperCase(), task: '做 $id', needs: needs, state: state, tries: 0);

  test('layersOf puts each step after the steps it needs; blockedBy and asksForYou read the board', () {
    final nodes = [
      node('api'),
      node('ui', needs: ['api']),
      node('docs'),
      node('e2e', needs: ['ui', 'docs']),
    ];
    expect(layersOf(nodes), [
      ['api', 'docs'],
      ['ui'],
      ['e2e'],
    ]);
    final pb = Playbook(id: 'p1', title: '打卡', goal: '', project: 'clock-in', state: PlaybookState.running, nodes: nodes, parallel: 2, createdAt: 0);
    expect(blockedBy(pb, nodes[3]), ['ui', 'docs']);
    expect(asksForYou(pb), isFalse);
    expect(asksForYou(Playbook(id: 'p2', title: '', goal: '', project: '', state: PlaybookState.draft, nodes: const [], parallel: 1, createdAt: 0)), isTrue);
  });

  test('playbookEventText names the step by its title', () {
    final e = PlaybookEvent(seq: 1, playbook: 'p1', node: 'api', kind: PlaybookEventKind.nodeMerged, actor: PlaybookActor.farm, commits: const ['abc'], at: 0);
    expect(playbookEventText(e, (id) => id.toUpperCase()), '「API」合进了计划分支（abc）');
  });

  test('standing: the tier reached, the count, what the next tier needs', () {
    final harvests = achievementOf('harvests')!;
    expect(standing(progress, harvests), (tier: 1, count: 4, next: 20));
    expect(isTitle(harvests), isTrue);
    expect(streakMultiplier(3), closeTo(1.2, 1e-9));
  });

  test('turnEndingAt: from the last line it was told up to the message', () {
    WorkStep s(int n, StepKind kind, double at) => WorkStep(n: n.toDouble(), at: at, kind: kind, text: '');
    final steps = [s(1, StepKind.asked, 0), s(2, StepKind.tool, 10), s(3, StepKind.asked, 10000), s(4, StepKind.tool, 10010), s(5, StepKind.said, 10020)];
    // A message lands a moment after its last step: steps up to 3 s later still count.
    expect(turnEndingAt(steps, 50).map((x) => x.n), [1, 2]);
    expect(turnEndingAt(steps, 7500).map((x) => x.n), [3, 4, 5]);
  });
}
