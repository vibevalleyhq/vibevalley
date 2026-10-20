import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../audio/sfx.dart';
import '../data/prefs.dart';
import '../data/providers.dart';
import '../data/remote.dart' show agentsProvider, projectNamesProvider, projectTemplatesProvider;
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../rules/issues.dart' show queuedIn;
import '../ui/common.dart';

/// The sowing bag: the server's issue templates for the project (project.templates), its queued todos, or the owner's own words.
/// Both skins open it: the farm on one of its beds (farm/seed_bag_view.dart), the project map on an island's empty spot
/// (workbench/map/seed_bag_view.dart). What it offers and what it does is here; each skin only draws it.
abstract class SeedBag extends ConsumerStatefulWidget {
  const SeedBag({super.key, required this.onDone, this.station, this.project});
  final VoidCallback onDone;

  /// The farm plot it sows on; null from the map, where the server picks the plot.
  final int? station;

  /// Where it sows (the island's project). Without one: the project last sown in, the only one, or it asks first.
  final String? project;
}

enum SeedPocket { seeds, queued }

/// Who picks the helper when the owner does not.
const seedByManager = 'auto';

typedef TemplateKindShown = ({TemplateKind kind, List<IssueTemplate> templates});

/// The bag's seeds under the filter: the recent words, and each kind with the templates that match it or its name.
({List<String> recent, List<TemplateKindShown> kinds}) seedsShown(ProjectTemplates? bag, String filter) {
  final q = filter.trim().toLowerCase();
  bool shown(String title) => q.isEmpty || title.toLowerCase().contains(q);
  return (
    recent: [
      for (final r in bag?.recent ?? const <String>[])
        if (shown(r)) r,
    ],
    kinds: [
      for (final k in bag?.kinds ?? const <TemplateKind>[])
        if (k.templates.where((s) => shown(s.title) || shown(k.name)).toList() case final rows when rows.isNotEmpty) (kind: k, templates: rows),
    ],
  );
}

/// The bag's state and acts, mixed into each skin's view.
mixin SeedBagState<W extends SeedBag> on ConsumerState<W> {
  String? _who;
  String? _project;
  var _choosing = false;
  var _pocket = SeedPocket.seeds;
  var _text = '';
  TextSelection? _selection;
  var _filter = '';
  String? _refused;
  final words = FocusNode(debugLabel: 'seed words');

  String get text => _text;
  TextSelection? get selection => _selection;
  String get filter => _filter;
  SeedPocket get pocket => _pocket;
  String? get refused => _refused;
  bool get canSow => _text.trim().isNotEmpty;

  @override
  void dispose() {
    words.dispose();
    super.dispose();
  }

  void setText(String v) => setState(() => _text = v);
  void setFilter(String v) => setState(() => _filter = v);
  void setPocket(SeedPocket p) => setState(() => _pocket = p);
  void chooseWho(String id) => setState(() => _who = id);
  void chooseProjectAgain() => setState(() => _choosing = true);
  void pickProject(String p) => setState(() {
    _project = p;
    _choosing = false;
  });

  /// A seed or a template into the words; a template's first blank selected.
  void take(String text, [TemplateBlank? blank]) {
    setState(() {
      _text = text;
      _selection = blank == null ? null : TextSelection(baseOffset: blank.start.round(), extentOffset: blank.end.round());
    });
    words.requestFocus();
  }

  /// The projects there are, and the one it sows in (null: ask first).
  ({List<String> projects, String? project}) whereToSow() {
    final known = ref.watch(projectNamesProvider);
    final projects = known.value ?? const <String>[];
    // Trusted while the list loads; dropped once the list says the project is gone.
    final last = switch (ref.watch(prefsProvider.select((p) => p.lastProject))) {
      final p? when !known.hasValue || projects.contains(p) => p,
      _ => null,
    };
    final project = _choosing ? null : _project ?? widget.project ?? last ?? (projects.length == 1 ? projects.single : null);
    return (projects: projects, project: project);
  }

  AsyncValue<ProjectTemplates> templatesOf(String project) => ref.watch(projectTemplatesProvider(project));

  List<Issue> queuedOf(String project) => queuedIn(ref.watch(stateProvider)?.issues ?? const <Issue>[], project);

  /// The helpers it can sow with, and who sows now: the one picked, the last one picked, or the manager.
  ({List<Agent> agents, String who}) whoSows() {
    final agents = (ref.watch(agentsProvider).value ?? const <String, Agent>{}).values.where((a) => a.enabled).toList();
    final pick = ref.watch(prefsProvider.select((p) => p.pick));
    return (agents: agents, who: _who ?? (agents.any((a) => a.id == pick) ? pick : seedByManager));
  }

  String? _agent(String who) => who == seedByManager ? null : who;

  void sow(String project, String who) {
    if (!canSow) return;
    Sfx.play('plant');
    ref.read(prefsProvider.notifier).setLastProject(project);
    fire(ref.read(farmCommandsProvider).plant(_text, station: widget.station, agent: _agent(who), project: project));
    widget.onDone();
  }

  /// Not sown now: the words become an issue in the backlog, a helper drafts it, and its detail opens on the board.
  Future<void> write(String project, String who) async {
    if (!canSow) return;
    final router = GoRouter.maybeOf(context);
    try {
      final got = await writeIssue(ref.read(apiProvider).issue, text: _text, project: project, agent: _agent(who));
      if (got.refused.isNotEmpty) toasts.add(type: ToastType.info, title: '先没起草', description: got.refused);
      ref.read(prefsProvider.notifier).setLastProject(project);
      widget.onDone();
      router?.go('/issues/${Uri.encodeComponent(got.issue.id)}');
    } on Object catch (e) {
      if (mounted) setState(() => _refused = e is VibeValleyApiError ? e.reason : '$e');
    }
  }

  /// The queued issue itself starts, on this bed if there is one.
  Future<void> start(Issue i, String project) async {
    final got = await ref.read(farmCommandsProvider).startQueued(i.id, station: widget.station);
    if (!mounted) return;
    if (got.ok) {
      ref.read(prefsProvider.notifier).setLastProject(project);
      Sfx.play('plant');
      widget.onDone();
    } else {
      setState(() => _refused = got.text);
    }
  }
}
