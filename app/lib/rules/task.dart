import '../gen/vibevalley.dart';

typedef Answer = ({bool ok, String text});

TaskGraph? graphOf(List<TaskGraph> graphs, String id) => graphs.where((p) => p.id == id).firstOrNull;
Task? taskOf(TaskGraph graph, String id) => graph.tasks.where((n) => n.id == id).firstOrNull;

bool isOpen(TaskGraph graph) => graph.state != GraphState.done && graph.state != GraphState.abandoned;
