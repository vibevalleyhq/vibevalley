import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/board.dart';
import 'package:vibevalley/rules/issues.dart';

typedef _Row = ({String id, RowFacts facts});

_Row _row(String id, Lane lane, {Priority? priority, double created = 0, double updated = 0, String? project, String? agent}) =>
    (id: id, facts: RowFacts(lane: lane, priority: priority, createdAt: created, updatedAt: updated, project: project, agent: agent));

List<String> _ids(List<_Row> rows) => [for (final r in rows) r.id];

RowFacts _facts(_Row r) => r.facts;

void main() {
  final rows = [
    _row('a', Lane.todo, priority: Priority.low, created: 1, updated: 5, project: 'site', agent: 'x'),
    _row('b', Lane.working, priority: Priority.urgent, created: 3, updated: 2, project: 'clock'),
    _row('c', Lane.todo, priority: Priority.medium, created: 2, updated: 9, agent: 'x'),
    _row('d', Lane.closed, created: 4, updated: 1, project: 'clock', agent: 'y'),
    _row('e', Lane.todo, priority: Priority.urgent, created: 0, updated: 3, project: 'site'),
  ];

  test('the default order is the order the rows came in: 待办 keeps the owner\'s own', () {
    expect(_ids(orderRows(rows, Ordering.manual, _facts)), ['a', 'b', 'c', 'd', 'e']);
  });

  test('by priority urgent first, a task (no priority) last, ties in their old order', () {
    expect(_ids(orderRows(rows, Ordering.priority, _facts)), ['b', 'e', 'c', 'a', 'd']);
  });

  test('by update and by creation, newest first', () {
    expect(_ids(orderRows(rows, Ordering.updated, _facts)), ['c', 'a', 'e', 'b', 'd']);
    expect(_ids(orderRows(rows, Ordering.created, _facts)), ['d', 'b', 'c', 'a', 'e']);
  });

  test('by status every lane is a group in lane order, even empty ones', () {
    final groups = groupRows(rows, Grouping.status, _facts);
    expect([for (final g in groups) g.lane], Lane.values);
    expect(
      [for (final g in groups) _ids(g.rows)],
      [
        ['a', 'c', 'e'],
        ['b'],
        <String>[],
        ['d'],
      ],
    );
    expect(groupRows(const <_Row>[], Grouping.status, _facts).length, 4);
  });

  test('by project or helper the named groups come by name and the rows without one last', () {
    final byProject = groupRows(rows, Grouping.project, _facts);
    expect([for (final g in byProject) g.key], ['clock', 'site', '']);
    expect(
      [for (final g in byProject) _ids(g.rows)],
      [
        ['b', 'd'],
        ['a', 'e'],
        ['c'],
      ],
    );
    final byAgent = groupRows(rows, Grouping.agent, _facts);
    expect([for (final g in byAgent) g.key], ['x', 'y', '']);
    expect(_ids(byAgent.last.rows), ['b', 'e']);
  });

  test('no grouping is one group of everything', () {
    final groups = groupRows(rows, Grouping.none, _facts);
    expect(groups.single.key, '');
    expect(_ids(groups.single.rows), _ids(rows));
  });

  test('the saved look reads back, and an unknown or short save falls back to the defaults', () {
    const look = (view: BoardView.list, grouping: Grouping.project, ordering: Ordering.updated);
    expect(lookFromList(lookToList(look)), look);
    expect(lookFromList(null), defaultLook);
    expect(lookFromList(['list', 'nonsense']), (view: BoardView.list, grouping: Grouping.status, ordering: Ordering.manual));
  });
}
