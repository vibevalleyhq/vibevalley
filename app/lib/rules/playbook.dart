import '../gen/vibevalley.dart';

typedef Answer = ({bool ok, String text});

Playbook? playbookOf(List<Playbook> plans, String id) => plans.where((p) => p.id == id).firstOrNull;
PlaybookNode? nodeOf(Playbook pb, String id) => pb.nodes.where((n) => n.id == id).firstOrNull;

bool isOpen(Playbook pb) => pb.state != PlaybookState.done && pb.state != PlaybookState.abandoned;

const nodeStateText = {NodeState.waiting: '等着', NodeState.working: '在做', NodeState.merged: '合进去了', NodeState.failed: '没做成', NodeState.skipped: '跳过了'};

const actorText = {PlaybookActor.user: '主人', PlaybookActor.manager: '管家', PlaybookActor.system: '农场'};
