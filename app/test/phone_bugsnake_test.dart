// 贪吃虫 as values (packages/core/test/bugsnake.test.ts ported): it crawls a cell a tick and turns but never back on
// itself, a seed grows it a segment, a bug lands every fifth seed and flies off unless eaten, the wall and its own
// body end a run but its tail's cell does not, and the same seed and turns make the run the web page makes.

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/phone/bug_snake.dart';
import 'package:vibevalley/phone/bug_snake_game.dart';
import 'package:vibevalley/phone/pad.dart';

const w = bugSnakeWidth;
int at(int x, int y) => y * w + x;

BugSnake make(BugSnake g, {List<int>? body, SnakeHeading? heading, List<SnakeHeading>? turns, int? grow, int? food, int? bug, int? bugLeft, int? eaten}) =>
    BugSnake(
      body: body ?? g.body,
      heading: heading ?? g.heading,
      turns: turns ?? g.turns,
      grow: grow ?? g.grow,
      food: food ?? g.food,
      bug: bug ?? g.bug,
      bugLeft: bugLeft ?? g.bugLeft,
      eaten: eaten ?? g.eaten,
      bugs: g.bugs,
      score: g.score,
      seed: g.seed,
      over: g.over,
    );

/// A fixed board: the caterpillar along row 7 heading right, the seed far away in a corner.
BugSnake lined({List<int>? body, SnakeHeading? heading, List<SnakeHeading>? turns, int? grow, int? food, int? eaten}) =>
    make(newBugSnake(1), body: body, heading: heading, turns: turns, grow: grow, food: food ?? at(0, 0), eaten: eaten);

BugSnake crawl(BugSnake g, int n) {
  var x = g;
  for (var i = 0; i < n; i++) {
    x = crawlBugSnake(x);
  }
  return x;
}

/// The test's pilot, the same as bugsnake.test.ts's: of the ways that do not end the run (up, right, down, left in that
/// order, never back), the first nearest the bug or else the seed.
SnakeHeading pilot(BugSnake g) {
  final target = g.bug ?? g.food;
  final head = g.body.first;
  final kept = g.grow > 0 ? g.body : g.body.sublist(0, g.body.length - 1);
  const back = {
    SnakeHeading.up: SnakeHeading.down,
    SnakeHeading.down: SnakeHeading.up,
    SnakeHeading.left: SnakeHeading.right,
    SnakeHeading.right: SnakeHeading.left,
  };
  var best = g.heading;
  var bestDistance = 1 << 30;
  for (final (d, dx, dy) in const [(SnakeHeading.up, 0, -1), (SnakeHeading.right, 1, 0), (SnakeHeading.down, 0, 1), (SnakeHeading.left, -1, 0)]) {
    if (d == back[g.heading]) continue;
    final x = head % w + dx;
    final y = head ~/ w + dy;
    if (x < 0 || x >= w || y < 0 || y >= bugSnakeHeight || kept.contains(at(x, y))) continue;
    final distance = (x - target % w).abs() + (y - target ~/ w).abs();
    if (distance < bestDistance) (best, bestDistance) = (d, distance);
  }
  return best;
}

/// Runs the pilot from a seed for at most `ticks`, or until the run ends.
(int, BugSnake) piloted(int seed, int ticks) {
  var g = newBugSnake(seed);
  var t = 0;
  for (; t < ticks && g.over == null; t++) {
    g = crawlBugSnake(steerBugSnake(g, pilot(g)));
  }
  return (t, g);
}

void main() {
  test('a new run: three segments heading right, a seed on a free cell', () {
    final g = newBugSnake(7);
    expect(g.body, [at(5, 7), at(4, 7), at(3, 7)]);
    expect(g.food >= 0 && g.food < w * bugSnakeHeight && !g.body.contains(g.food), isTrue);
    expect(bugSnakeStepMs(g), 200);
  });

  test('it crawls a cell a tick, turns at the next tick, and never turns back on itself', () {
    final g = crawlBugSnake(lined());
    expect(g.body, [at(6, 7), at(5, 7), at(4, 7)]);
    expect(identical(steerBugSnake(g, SnakeHeading.left), g), isTrue, reason: 'no turning back');
    expect(identical(steerBugSnake(g, SnakeHeading.right), g), isTrue, reason: 'already going that way');
    final up = crawlBugSnake(steerBugSnake(g, SnakeHeading.up));
    expect(up.heading, SnakeHeading.up);
    expect(up.body.first, at(6, 6));
    final u = crawl(steerBugSnake(steerBugSnake(g, SnakeHeading.up), SnakeHeading.left), 2);
    expect(u.body, [at(5, 6), at(6, 6), at(6, 7)]);
    expect(steerBugSnake(steerBugSnake(steerBugSnake(g, SnakeHeading.up), SnakeHeading.left), SnakeHeading.down).turns.length, 2, reason: 'two at most');
  });

  test('a seed grows it a segment and scores; another lands on a free cell', () {
    final g = crawlBugSnake(lined(food: at(6, 7)));
    expect(g.eaten, 1);
    expect(g.score, seedPoints);
    expect(g.body.contains(g.food), isFalse);
    final grown = crawlBugSnake(g);
    expect(grown.body.length, 4, reason: 'the tail stayed a tick');
    expect(crawlBugSnake(grown).body.length, 4);
  });

  test('a bug lands with the fifth seed, is worth more the sooner, and flies off uneaten', () {
    final g = crawlBugSnake(lined(food: at(6, 7), eaten: 4));
    expect(g.eaten, 5);
    expect(g.bug, isNotNull);
    expect(g.bugLeft, bugTicks);
    expect(!g.body.contains(g.bug) && g.bug != g.food, isTrue);
    final fed = crawlBugSnake(make(g, bug: at(7, 7), food: at(0, 0)));
    expect(fed.bugs, 1);
    expect(fed.bug, isNull);
    expect(fed.score, seedPoints + bugPoints + bugTicks);
    expect(fed.grow, 1 + 2 - 1, reason: 'the seed and the bug, less the tick grown');
    final away = make(g, bug: at(15, 0), bugLeft: 5, food: at(0, 0), turns: const []);
    expect(crawl(away, 4).bug, at(15, 0));
    expect(crawl(away, 4).bugLeft, 1);
    expect(crawl(away, 5).bug, isNull);
  });

  test('the wall and its own body end a run; its tail cell does not', () {
    final wall = crawl(lined(), w);
    expect(wall.over, BugSnakeEnd.wall);
    expect(identical(crawlBugSnake(wall), wall), isTrue, reason: 'nothing moves after');
    expect(identical(steerBugSnake(wall, SnakeHeading.up), wall), isTrue);
    final ring = lined(body: [at(5, 6), at(5, 7), at(6, 7), at(6, 6)], heading: SnakeHeading.up, turns: const [SnakeHeading.right]);
    expect(crawlBugSnake(ring).over, isNull);
    expect(crawlBugSnake(make(ring, grow: 1)).over, BugSnakeEnd.self, reason: 'a growing tail stays put');
    final long = lined(body: [at(5, 6), at(5, 7), at(6, 7), at(6, 6), at(7, 6)], heading: SnakeHeading.up, turns: const [SnakeHeading.right]);
    expect(crawlBugSnake(long).over, BugSnakeEnd.self);
  });

  test('it quickens as it grows', () {
    expect(bugSnakeStepMs(lined(body: List.generate(20, (i) => i))), lessThan(200));
    expect(bugSnakeStepMs(lined(body: List.generate(100, (i) => i))), 80);
  });

  test('a seed runs what the web page runs from it', () {
    // From packages/core bugsnake.ts with the same seeds and pilot (node): ticks, end, score, seeds, bugs, length,
    // the seed's cell, the bug's, and the generator's state.
    List<Object?> summary(int seed) {
      final (t, g) = piloted(seed, 3000);
      return [t, g.over?.name, g.score, g.eaten, g.bugs, g.body.length, g.food, g.bug, g.seed];
    }

    expect(summary(1), [266, 'self', 357, 20, 3, 29, 111, 144, -1455494930]);
    expect(summary(42), [255, 'wall', 312, 18, 3, 27, 10, null, 1639742264]);
    expect(summary(2024), [191, 'self', 248, 15, 2, 22, 32, 0, 440014103]);
    expect([1, 42, 2024].map((s) => newBugSnake(s).food), [141, 135, 182]);
    expect(piloted(42, 3000).$2, piloted(42, 3000).$2, reason: 'a seed replays');
  });

  testWidgets('on the big phone\'s screen: A starts, the arrows steer, B pauses, the wall ends it and keeps the best', (tester) async {
    final pad = Pad();
    final container = ProviderContainer();
    // The big handset's screen, under its status bar.
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: SizedBox(width: 336, height: 410, child: BugSnakeGame(pad: pad)),
          ),
        ),
      ),
    );
    expect(find.text('按 A 开始'), findsOneWidget);
    pad.press(PadButton.a, true);
    await tester.pump();
    expect(find.text('按 A 开始'), findsNothing);
    final started = container.read(bugSnakeGameProvider)!;
    pad.press(PadButton.up, true);
    await tester.pump(const Duration(milliseconds: 210));
    await tester.pump(const Duration(milliseconds: 16));
    final moved = container.read(bugSnakeGameProvider)!;
    expect(moved.heading, SnakeHeading.up);
    expect(moved.body.first, started.body.first - bugSnakeWidth);
    pad.press(PadButton.b, true);
    await tester.pump();
    expect(find.text('按 A 继续'), findsOneWidget);
    pad.press(PadButton.a, true);
    await tester.pump();
    for (var i = 0; i < 400 && find.text('按 A 再来').evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(container.read(bugSnakeGameProvider)!.over, BugSnakeEnd.wall);
    expect(find.text('撞到田埂了'), findsOneWidget);
    expect(container.read(bugSnakeBestProvider), container.read(bugSnakeGameProvider)!.score);
    await tester.pumpWidget(const SizedBox());
    container.dispose();
  });
}
