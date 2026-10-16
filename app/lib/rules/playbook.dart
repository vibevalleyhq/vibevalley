// Ported from packages/protocol/src/playbook.ts (finding a playbook and a step, isSettled, isOpen, asksForYou, blockedBy,
// playbookSpent, NODE_STATE_TEXT, layersOf, ACTOR_TEXT, playbookEventText) and packages/core/src/playbooks.ts (Answer).

import 'dart:math' as math;

import '../gen/vibevalley.dart';

/// A command's answer: done, with a line about it, or refused, with why (core playbooks.ts Answer).
typedef Answer = ({bool ok, String text});

Playbook? playbookOf(List<Playbook> plans, String id) => plans.where((p) => p.id == id).firstOrNull;
PlaybookNode? nodeOf(Playbook pb, String id) => pb.nodes.where((n) => n.id == id).firstOrNull;

/// Its work is in, or you said to go on without it.
bool isSettled(PlaybookNode n) => n.state == NodeState.merged || n.state == NodeState.skipped;

/// Not harvested, not given up.
bool isOpen(Playbook pb) => pb.state != PlaybookState.done && pb.state != PlaybookState.abandoned;

/// It waits on you: a draft to look over, a step that failed, a whole playbook to harvest.
bool asksForYou(Playbook pb) =>
    pb.state == PlaybookState.draft || pb.state == PlaybookState.ripe || (isOpen(pb) && pb.nodes.any((n) => n.state == NodeState.failed));

/// The steps `node` waits for that are not settled yet.
List<String> blockedBy(Playbook pb, PlaybookNode node) => node.needs.where((id) {
  final need = nodeOf(pb, id);
  return need == null || !isSettled(need);
}).toList();

/// What its steps cost, added up; null before any step spent anything.
Spent? playbookSpent(Playbook pb) {
  final spent = [for (final n in pb.nodes) ?n.spent];
  if (spent.isEmpty) return null;
  final priced = spent.where((s) => s.cny != null).toList();
  return Spent(tokens: spent.fold(0, (t, s) => t + s.tokens), cny: priced.isEmpty ? null : priced.fold<double>(0, (t, s) => t + s.cny!));
}

const nodeStateText = {NodeState.waiting: '等着', NodeState.working: '在做', NodeState.merged: '合进去了', NodeState.failed: '没做成', NodeState.skipped: '跳过了'};

/// The steps in layers, each after every step it needs: the columns of the plan board. A step in a circle is in none.
List<List<String>> layersOf(List<PlaybookNode> nodes) {
  final known = {for (final n in nodes) n.id};
  final depth = <String, int>{};
  var changed = true;
  for (var pass = 0; changed && pass <= nodes.length; pass++) {
    changed = false;
    for (final n in nodes) {
      if (depth.containsKey(n.id)) continue;
      final needs = n.needs.where((x) => known.contains(x) && x != n.id).toList();
      if (!needs.every(depth.containsKey)) continue;
      depth[n.id] = needs.isEmpty ? 0 : needs.map((x) => depth[x] ?? 0).reduce(math.max) + 1;
      changed = true;
    }
  }
  final layers = <int, List<String>>{};
  for (final n in nodes) {
    final d = depth[n.id];
    if (d != null) (layers[d] ??= []).add(n.id);
  }
  return [for (final d in layers.keys.toList()..sort()) layers[d]!];
}

const actorText = {PlaybookActor.user: '主人', PlaybookActor.foreman: '管家', PlaybookActor.farm: '农场'};

/// protocol playbookEventText: an event in words. `titleOf` names a step by its id.
String playbookEventText(PlaybookEvent e, String Function(String node) titleOf) {
  final step = '「${e.node != null ? titleOf(e.node!) : ''}」';
  final by = e.helper != null ? '（${e.helper}）' : '';
  final why = e.detail != null ? '：${e.detail}' : '';
  return switch (e.kind) {
    PlaybookEventKind.planning => '要拆一张计划$why',
    PlaybookEventKind.drafted => '拆好了${e.detail != null ? '，${e.detail}' : ''}，等主人看',
    PlaybookEventKind.started => '开工了${e.detail != null ? '，分支 ${e.detail}' : ''}',
    PlaybookEventKind.paused => '暂停了$why',
    PlaybookEventKind.resumed => '接着做了',
    PlaybookEventKind.ripe => '都做完了，等收获',
    PlaybookEventKind.harvested => '收进了主分支',
    PlaybookEventKind.abandoned => '放弃了$why',
    PlaybookEventKind.noted => e.detail ?? '',
    PlaybookEventKind.nodeStarted => '$step开工$by',
    PlaybookEventKind.nodeSentBack => '$step退回去重做$by$why',
    PlaybookEventKind.nodeMerged => '$step合进了计划分支${(e.commits ?? const []).isNotEmpty ? '（${e.commits!.join('、')}）' : ''}$why',
    PlaybookEventKind.nodeFailed => '$step没做成$why',
    PlaybookEventKind.nodeRetried => '$step重试',
    PlaybookEventKind.nodeRequeued => '$step没有帮工在做了，重新排上',
    PlaybookEventKind.nodeSkipped => '$step跳过了，后面的照做',
    PlaybookEventKind.nodeEdited => '改了$step的${(e.changes ?? const []).map((c) => c.field).join('、')}',
    PlaybookEventKind.nodeAdded => '加了一步$step',
    PlaybookEventKind.nodeRemoved => '删了一步「${e.detail ?? e.node ?? ''}」',
  };
}
