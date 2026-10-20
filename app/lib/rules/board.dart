import '../gen/vibevalley.dart';
import 'issues.dart';

/// How the issues page shows its cards: four lanes to drag between, or one list of rows.
enum BoardView {
  board('看板'),
  list('列表');

  const BoardView(this.label);
  final String label;
}

/// Groups of the list view. The board keeps its status lanes whatever this is: a drag between lanes moves status.
enum Grouping {
  status('状态'),
  project('项目'),
  agent('帮工'),
  none('不分组');

  const Grouping(this.label);
  final String label;
}

/// `manual` keeps the order the rows came in: the history's, which for 待办 is the owner's own order.
enum Ordering {
  manual('默认'),
  priority('优先级'),
  updated('最近更新'),
  created('创建时间');

  const Ordering(this.label);
  final String label;
}

/// The view, grouping and ordering the owner last picked.
typedef BoardLook = ({BoardView view, Grouping grouping, Ordering ordering});

const defaultLook = (view: BoardView.board, grouping: Grouping.status, ordering: Ordering.manual);

/// Saved as three names; an unknown name falls back to its default.
List<String> lookToList(BoardLook look) => [look.view.name, look.grouping.name, look.ordering.name];

BoardLook lookFromList(List<String>? raw) {
  T pick<T extends Enum>(List<T> all, int i, T fallback) => all.where((v) => raw != null && raw.length > i && v.name == raw[i]).firstOrNull ?? fallback;
  return (
    view: pick(BoardView.values, 0, defaultLook.view),
    grouping: pick(Grouping.values, 1, defaultLook.grouping),
    ordering: pick(Ordering.values, 2, defaultLook.ordering),
  );
}

/// What grouping and ordering read from a row. A task has no priority of its own: null sorts after low.
class RowFacts {
  const RowFacts({required this.lane, required this.createdAt, required this.updatedAt, this.priority, this.project, this.agent});
  final Lane lane;
  final Priority? priority;
  final double createdAt;
  final double updatedAt;
  final String? project;
  final String? agent;
}

int priorityRank(Priority? p) => switch (p) {
  Priority.urgent => 0,
  Priority.high => 1,
  Priority.medium => 2,
  Priority.low => 3,
  null => 4,
};

/// Stable: rows that tie keep the order they came in.
List<T> orderRows<T>(List<T> rows, Ordering ordering, RowFacts Function(T row) facts) {
  if (ordering == Ordering.manual) return rows;
  final indexed = [for (final (i, r) in rows.indexed) (i, r, facts(r))];
  int key((int, T, RowFacts) a, (int, T, RowFacts) b) => switch (ordering) {
    Ordering.manual => 0,
    Ordering.priority => priorityRank(a.$3.priority).compareTo(priorityRank(b.$3.priority)),
    Ordering.updated => b.$3.updatedAt.compareTo(a.$3.updatedAt),
    Ordering.created => b.$3.createdAt.compareTo(a.$3.createdAt),
  };
  indexed.sort((a, b) {
    final k = key(a, b);
    return k != 0 ? k : a.$1.compareTo(b.$1);
  });
  return [for (final e in indexed) e.$2];
}

/// One group of rows. `key` is the lane's name, the project, the agent id, or '' for rows without one (and for the
/// single group of `Grouping.none`).
class RowGroup<T> {
  const RowGroup(this.key, this.rows, {this.lane});
  final String key;
  final Lane? lane;
  final List<T> rows;
}

/// By status every lane is a group, even empty, in lane order; by project or agent the named groups come by name and
/// the rows without one last. Rows keep their order inside a group.
List<RowGroup<T>> groupRows<T>(List<T> rows, Grouping grouping, RowFacts Function(T row) facts) {
  switch (grouping) {
    case Grouping.none:
      return [RowGroup('', rows)];
    case Grouping.status:
      return [
        for (final lane in Lane.values)
          RowGroup(lane.name, [
            for (final r in rows)
              if (facts(r).lane == lane) r,
          ], lane: lane),
      ];
    case Grouping.project || Grouping.agent:
      final by = <String, List<T>>{};
      for (final r in rows) {
        final f = facts(r);
        by.putIfAbsent((grouping == Grouping.project ? f.project : f.agent) ?? '', () => []).add(r);
      }
      final keys = by.keys.toList()
        ..sort((a, b) {
          if (a.isEmpty != b.isEmpty) return a.isEmpty ? 1 : -1;
          return a.compareTo(b);
        });
      return [for (final k in keys) RowGroup(k, by[k]!)];
  }
}
