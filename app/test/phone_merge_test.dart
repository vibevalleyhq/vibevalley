import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/phone/merge.dart';
import 'package:vibevalley/phone/merge_game.dart';
import 'package:vibevalley/phone/pad.dart';
import 'package:vibevalley/shell/sfx.dart';

Merge on(List<int> board, [int seed = 1]) => newMerge(seed).copyWith(board: board);

List<int> slid(Merge g) => [for (var i = 0; i < g.board.length; i++) i == g.sown ? 0 : g.board[i]];

const _dirs = {'l': MergeDirection.left, 'u': MergeDirection.up, 'r': MergeDirection.right, 'd': MergeDirection.down};

Merge play(int seed, String path) {
  var g = newMerge(seed);
  for (final c in path.split('')) {
    g = slideMerge(g, _dirs[c]!);
  }
  return g;
}

void main() {
  test('a seed replays the recorded games', () {
    final cases = [
      (42, 'lurdllurrdduuldr', '0000001001000000', -631835628, '0,0,0,0,0,1,2,1,0,1,2,1,0,0,2,4', 60, 16, -1391553692, [15], 5),
      (7, 'ddddllllrrrruuuu', '1100000000000000', -631835663, '2,1,2,3,0,0,1,1,0,0,2,1,0,0,0,0', 28, 12, -127882387, <int>[], 11),
      (123456789, 'lulululurdrdrdrdldlduuu', '0000100000000001', -508378881, '1,3,2,0,2,4,0,0,3,1,0,0,0,0,0,0', 88, 20, 1763199011, <int>[], 9),
    ];
    for (final (seed, path, start, startSeed, board, score, moves, seedAfter, grown, sown) in cases) {
      final n = newMerge(seed);
      expect(n.board.join(), start);
      expect(n.seed, startSeed);
      final g = play(seed, path);
      expect(g.board.join(','), board);
      expect(g.score, score);
      expect(g.moves, moves);
      expect(g.seed, seedAfter);
      expect(g.grown, grown);
      expect(g.sown, sown);
      expect(g.over, isFalse);
    }
    // A long game to the end, slides picked by a little LCG: Math.imul(r, 1103515245) + 12345, (r >>> 16) & 3.
    var g = newMerge(2024);
    var r = 99;
    var k = 0;
    const order = [MergeDirection.left, MergeDirection.up, MergeDirection.right, MergeDirection.down];
    while (!g.over && k < 5000) {
      r = ((r * 1103515245).toSigned(32) + 12345).toSigned(32);
      g = slideMerge(g, order[((r & 0xFFFFFFFF) >> 16) & 3]);
      k++;
    }
    expect(g.board.join(','), '1,3,5,1,3,4,8,3,2,5,6,5,1,4,3,1');
    expect(g.score, 2660);
    expect(g.moves, 244);
    expect(g.seed, -406374058);
    expect(g.over, isTrue);
    expect(k, 291);
  });

  test('a new field has two seeds, and a seed lays them out the same again', () {
    final g = newMerge(42);
    expect(g.board.length, mergeSize * mergeSize);
    expect(g.board.where((c) => c != 0), [1, 1]);
    expect(newMerge(42), g);
    expect(play(7, 'lurdllu'), play(7, 'lurdllu'));
  });

  test('crops slide to the edge; two of a stage grow into the next, once a slide, nearest the edge first', () {
    final g = on([1, 1, 1, 1, 2, 0, 2, 3, 1, 1, 2, 0, 0, 0, 0, 4]);
    final after = slideMerge(g, MergeDirection.left);
    expect(slid(after), [2, 2, 0, 0, 3, 3, 0, 0, 2, 2, 0, 0, 4, 0, 0, 0]);
    expect(after.score, 4 + 4 + 8 + 4);
    expect(after.grown, [0, 1, 4, 8]);
    expect(after.board[after.sown], 1);
    expect(after.moves, 1);
    expect(slid(slideMerge(on([0, 1, 1, 1, ...List.filled(12, 0)]), MergeDirection.right)).sublist(0, 4), [0, 0, 1, 2]);
    expect(slid(slideMerge(on([2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), MergeDirection.down)).where((c) => c != 0), [3, 2]);
  });

  test('a slide that moves nothing is no move: no seed, the same game back', () {
    final g = on([1, 2, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(identical(slideMerge(g, MergeDirection.left), g), isTrue);
    expect(identical(slideMerge(g, MergeDirection.up), g), isTrue);
    expect(identical(slideMerge(g, MergeDirection.right), g), isFalse);
  });

  test('a full field with no pair side by side ends the run, and nothing slides after', () {
    final full = [2, 1, 2, 1, 1, 2, 1, 2, 2, 1, 2, 1, 3, 4, 3, 0];
    expect(canSlide(full), isTrue);
    final g = slideMerge(on(full), MergeDirection.right);
    expect(g.board.sublist(12), [1, 3, 4, 3]);
    expect(g.over, isTrue);
    expect(canSlide(g.board), isFalse);
    for (final d in MergeDirection.values) {
      expect(identical(slideMerge(g, d), g), isTrue);
    }
  });

  test('one slide comes back, seed and all; not two', () {
    final g = play(9, 'lu');
    final next = slideMerge(g, MergeDirection.right);
    final back = undoMerge(next);
    expect(back, g.copyWith(previous: () => null));
    expect(slideMerge(back, MergeDirection.right).board, next.board);
    expect(identical(undoMerge(back), back), isTrue);
  });

  test('丰收 is the eleventh stage, 2048; past it the stages count on', () {
    expect(1 << mergeGoal, 2048);
    expect(mergeStages.length, mergeGoal);
    expect(mergeStageName(1), '种子');
    expect(mergeStageName(mergeGoal), '丰收');
    expect(mergeStageName(mergeGoal + 1), '丰收2');
    final g = slideMerge(on([10, 10, ...List.filled(14, 0)]), MergeDirection.left);
    expect(mergeTop(g), mergeGoal);
    expect(g.score, 2048);
  });

  testWidgets('on the phone: A starts, arrows and swipes slide, A mid-game asks before starting over, B takes a slide back', (tester) async {
    Sfx.setMuted(true);
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final pad = Pad();
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: SizedBox(width: 336, height: 416, child: MergeGame(pad: pad)),
          ),
        ),
      ),
    );
    expect(find.text('按 A 开始'), findsOneWidget);
    pad.press(PadButton.a, true);
    await tester.pump();
    final started = container.read(mergeGameProvider)!;
    expect(find.text('按 A 开始'), findsNothing);
    for (final b in [PadButton.left, PadButton.up, PadButton.right, PadButton.down]) {
      pad.press(b, true);
    }
    await tester.pump();
    final slid = container.read(mergeGameProvider)!;
    expect(slid.moves, greaterThan(started.moves));
    pad.press(PadButton.b, true);
    await tester.pump();
    expect(container.read(mergeGameProvider)!.moves, slid.moves - 1);
    final before = container.read(mergeGameProvider)!;
    for (final d in const [Offset(-80, 0), Offset(0, -80), Offset(80, 0), Offset(0, 80)]) {
      await tester.drag(find.bySemanticsLabel(RegExp('^田里')), d);
    }
    await tester.pump();
    expect(container.read(mergeGameProvider)!.moves, greaterThan(before.moves));
    pad.press(PadButton.a, true);
    await tester.pump();
    expect(find.text('重新种这块地？'), findsOneWidget);
    pad.press(PadButton.b, true);
    await tester.pump();
    expect(find.text('重新种这块地？'), findsNothing);
    expect(container.read(mergeGameProvider)!.moves, greaterThan(0), reason: 'B kept the field');
    Sfx.setMuted(false);
  });
}
