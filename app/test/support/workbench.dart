import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:http/http.dart' as http;
import 'server.dart';

export 'server.dart';

Look look({Species? species = Species.bear, Outfit? outfit = Outfit.farmer, String hat = '#e8804f'}) =>
    Look(species: species, outfit: outfit, build: Build.biped, head: Head.rounded, body: '#f3e9da', trim: '#d9774f', hat: hat, eye: '#a6f4ff');

Agent agent(
  String id,
  String name, {
  String runtime = 'claude',
  String role = '',
  String persona = '',
  PersonaMode personaMode = PersonaMode.append,
  List<String> skills = const [],
  bool enabled = true,
  List<String> tags = const [],
}) => Agent(
  id: id,
  name: name,
  role: role,
  enabled: enabled,
  runtime: runtime,
  model: '',
  effort: '',
  persona: persona,
  personaMode: personaMode,
  skills: skills,
  mcpServers: const [],
  disallowedTools: const [],
  env: const {},
  workdir: '',
  worktree: true,
  tags: tags,
  look: look(),
);

RuntimeInfo runtime(String id, {bool available = true, List<ModelEntry>? models, List<InventoryEntry>? skills, List<InventoryEntry>? tools}) => RuntimeInfo(
  id: id,
  installation: available ? const InstallationAvailable(via: Via.executable, command: 'x', version: '1.0.0') : const InstallationNotFound(),
  models: models,
  skills: skills,
  tools: tools,
  settings: const RuntimeSettings(enabled: true, binPath: '', defaultModel: '', defaultEffort: '', env: {}),
  checkedAt: 0,
);

Memory memory(String id, String text, {String agent = 'backend', MemoryKind kind = MemoryKind.note, String? project, String? session, double at = 0}) =>
    Memory(id: id, agent: agent, kind: kind, text: text, project: project, session: session, at: at, recalled: 0);

VoiceSettings voice({String greeting = '来啦！今天想种点什么？'}) => VoiceSettings(
  area: Area.uS,
  language: Language.zhCN,
  asr: const VoiceAsrAres(),
  answer: const VoiceAnswerAgora(model: VoiceAnswerAgoraModel.gpt41Mini),
  tts: const VoiceTtsMinimax(model: VoiceTtsMinimaxModel.speech26Turbo, voiceId: 'Chinese (Mandarin)_Gentle_Youth'),
  persona: '你是管家。',
  greeting: greeting,
  failureMessage: '我这边卡了一下，你再说一遍？',
  silenceMs: 480,
  interruptMs: 160,
  idleSeconds: 30,
);

/// The workbench's endpoints over lists it keeps: what a page writes, it reads back.
class WorkbenchBackend {
  WorkbenchBackend({
    List<Agent>? agents,
    List<Skill>? skills,
    List<RuntimeInfo>? runtimes,
    Map<String, List<Memory>>? memories,
    this.managerMemory,
    this.archive = const ArchiveListing(files: [], hits: []),
    this.archiveFiles = const {},
    this.events = const {},
    this.heads = const [],
    this.settings,
    this.projects = const [],
  }) : agents = [...?agents],
       skills = [...?skills],
       runtimes = [...?runtimes],
       memories = {...?memories};

  final List<Agent> agents;
  final List<Skill> skills;
  final List<RuntimeInfo> runtimes;
  final Map<String, List<Memory>> memories;
  MemoryList? managerMemory;
  final ArchiveListing archive;
  final Map<String, String> archiveFiles;
  // By session: its log (session.events), and the sessions session.list and session.get answer with.
  final Map<String, List<SessionEvent>> events;
  final List<Session> heads;
  SettingsStatus? settings;
  final List<ProjectSummary> projects;

  final calls = <Call>[];

  /// What agent.recall answers for an agent: the server's Pick is the Go's, tested there.
  final recalls = <String, List<String>>{};
  final memorySources = <String, List<MemorySourceInfo>>{};

  /// What changed something: the checks are questions, though they are POSTs.
  List<Call> get writes => calls.where((c) => c.method != 'GET' && !const {'/api/v1/agents/check', '/api/v1/settings/check'}.contains(c.path)).toList();

  Future<http.Response> handle(http.Request r) async {
    final path = r.url.path;
    final body = r.body.isEmpty ? null : jsonDecode(r.body);
    calls.add((method: r.method, path: r.url.hasQuery ? '$path?${r.url.query}' : path, body: body));
    final parts = path.split('/').where((p) => p.isNotEmpty).map(Uri.decodeComponent).toList();
    // The API's version prefix is one segment, not part of the route's own path.
    if (parts.length > 1 && parts[0] == 'api' && parts[1] == 'v1') parts.removeAt(1);
    switch ((r.method, parts)) {
      case ('POST', ['api', 'agents', 'check']):
        // The server's first check only: the rest of AgentIssues is the Go's, tested there.
        final asked = [for (final j in (body as Map)['agents'] as List) Agent.fromJson(j as Map<String, dynamic>)];
        return jsonResponse([
          for (final a in asked)
            {
              'id': a.id,
              'issues': [
                if (!runtimes.any((x) => x.id == a.runtime)) {'field': 'runtime', 'level': 'error', 'text': '不认识的 runtime：${a.runtime}'},
              ],
            },
        ]);
      case ('POST', ['api', 'agents']):
        final created = Agent.fromJson({...body as Map<String, dynamic>, 'id': 'created-agent'});
        agents.add(created);
        return jsonResponse(created.toJson());
      case ('POST', ['api', 'skills']):
        final created = Skill.fromJson({...body as Map<String, dynamic>, 'id': 'created-skill'});
        skills.add(created);
        return jsonResponse(created.toJson());
      case ('GET', ['api', 'agents']):
        return jsonResponse([for (final a in agents) a.toJson()]);
      case ('PUT', ['api', 'agents', final id]):
        final a = Agent.fromJson(body as Map<String, dynamic>);
        final i = agents.indexWhere((x) => x.id == id);
        if (i < 0) {
          agents.add(a);
        } else {
          agents[i] = a;
        }
        return jsonResponse(a.toJson());
      case ('DELETE', ['api', 'agents', final id]):
        agents.removeWhere((a) => a.id == id);
        return http.Response('', 204);
      case ('GET', ['api', 'skills']):
        return jsonResponse([for (final s in skills) s.toJson()]);
      case ('PUT', ['api', 'skills', final id]):
        final s = Skill.fromJson(body as Map<String, dynamic>);
        final i = skills.indexWhere((x) => x.id == id);
        if (i < 0) {
          skills.add(s);
        } else {
          skills[i] = s;
        }
        return jsonResponse(s.toJson());
      case ('DELETE', ['api', 'skills', final id]):
        skills.removeWhere((s) => s.id == id);
        for (var i = 0; i < agents.length; i++) {
          final a = agents[i];
          if (a.skills.contains(id)) agents[i] = Agent.fromJson({...a.toJson(), 'skills': a.skills.where((s) => s != id).toList()});
        }
        return http.Response('', 204);
      case ('GET', ['api', 'runtimes']):
        return jsonResponse([for (final x in runtimes) x.toJson()]);
      case ('GET', ['api', 'projects']):
        return jsonResponse([for (final p in projects) p.toJson()]);
      case ('GET', ['api', 'memories', final id, 'recall']):
        final lines = recalls[id] ?? const <String>[];
        return jsonResponse({'lines': lines, 'chars': lines.fold<int>(0, (n, l) => n + l.length + 1), 'limit': 1600});
      case ('GET', ['api', 'memories', final id]) when id != managerAgent:
        return jsonResponse(MemoryList(memories: memories[id] ?? const <Memory>[], sources: memorySources[id] ?? const []).toJson());
      case ('POST', ['api', 'memories', final id]) when id != managerAgent:
        final req = MemoryRequest.fromJson(body as Map<String, dynamic>);
        final m = memory('m${calls.length}', req.text, agent: id, project: req.project, at: 1);
        memories[id] = [m, ...?memories[id]];
        return jsonResponse(m.toJson());
      case ('DELETE', ['api', 'memories', final id, final mid]) when id != managerAgent:
        memories[id]?.removeWhere((m) => m.id == mid);
        return http.Response('', 204);
      case ('GET', ['api', 'memories', managerAgent]):
        return managerMemory == null ? jsonResponse({'_tag': 'Missing', 'reason': '没有'}, 404) : jsonResponse(managerMemory!.toJson());
      case ('POST', ['api', 'memories', managerAgent]):
        final req = MemoryRequest.fromJson(body as Map<String, dynamic>);
        final m = memory('mm${calls.length}', req.text, agent: 'manager', at: 1);
        final mm = managerMemory!;
        managerMemory = MemoryList(file: mm.file, sources: const [], memories: [m, ...mm.memories], carried: (mm.carried ?? 0) + 1);
        return jsonResponse(m.toJson());
      case ('DELETE', ['api', 'memories', managerAgent, final mid]):
        final mm = managerMemory!;
        managerMemory = MemoryList(file: mm.file, sources: const [], memories: mm.memories.where((m) => m.id != mid).toList(), carried: mm.carried);
        return http.Response('', 204);
      case ('GET', ['api', 'manager', 'archive']):
        final q = r.url.queryParameters['q'];
        return jsonResponse(q == null ? ArchiveListing(files: archive.files, hits: const []).toJson() : archive.toJson());
      case ('GET', ['api', 'manager', 'archive', final name]):
        return jsonResponse(archiveFiles[name] ?? '');
      case ('POST', ['api', 'manager', 'evals']):
        return jsonResponse(const ManagerEval(id: 'e1', file: '/home/me/.vibevalley/manager/evals/e1.json').toJson());
      case ('GET', ['api', 'sessions']):
        final agent = r.url.queryParameters['agent'];
        return jsonResponse([
          for (final h in heads)
            if (agent == null || h.agent == agent) h.toJson(),
        ]);
      case ('GET', ['api', 'sessions', final id, 'events']):
        return jsonResponse([for (final e in events[id] ?? const <SessionEvent>[]) e.toJson()]);
      case ('GET', ['api', 'sessions', final id]):
        final s = heads.where((h) => h.id == id).firstOrNull;
        return s == null ? jsonResponse({'_tag': 'Missing', 'reason': '没有'}, 404) : jsonResponse(s.toJson());
      case ('GET', ['api', 'settings']):
        return jsonResponse(settings!.toJson());
      case ('PUT', ['api', 'settings']):
        final update = SettingsUpdate.fromJson(body as Map<String, dynamic>);
        final s = settings!;
        final v = {...s.voiceDefaults.toJson(), ...?update.voice?.toJson()};
        settings = SettingsStatus.fromJson({...s.toJson(), 'voice': v});
        return jsonResponse(settings!.toJson());
      default:
        return jsonResponse({'_tag': 'Missing', 'reason': 'no ${r.method} $path'}, 404);
    }
  }
}

/// The providers go with the tree, so their retries end with the test.
Future<void> pumpPage(WidgetTester t, Widget page, Handle handle, {CoreState? farm, Stream<LiveEvent>? events, Size size = const Size(1600, 1200)}) async {
  t.view.physicalSize = size;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(
    ProviderScope(
      overrides: [
        serverProvider.overrideWithValue(FakeServer(handle)),
        sideEventsProvider.overrideWith((ref) => events ?? const Stream<LiveEvent>.empty()),
        stateProvider.overrideWithValue(farm),
        atlasProvider.overrideWith((ref) async => atlas),
      ],
      child: MaterialApp(
        theme: farmTheme(),
        home: Scaffold(body: page),
      ),
    ),
  );
  await settle(t);
}

Future<void> typeInto(WidgetTester t, String label, String text) async {
  await t.enterText(find.descendant(of: labelled(label), matching: find.byType(EditableText)).first, text);
  await t.pump();
}

Finder labelled(String label) => find.byWidgetPredicate((w) => w is Semantics && w.properties.label == label);

Map<String, dynamic> runtimeJson(
  String id, {
  bool available = true,
  bool enabled = true,
  Map<String, dynamic>? usage,
  List<Map<String, dynamic>>? models,
  double? spentToday,
  double? dailyBudget,
}) => {
  'id': id,
  'installation': available ? {'status': 'available', 'via': 'executable', 'command': '/usr/local/bin/$id', 'version': '1.2.3'} : {'status': 'not_found'},
  'models': ?models,
  'usage': ?usage,
  'skills': [
    {'name': 'review', 'description': '看代码'},
  ],
  'settings': {'enabled': enabled, 'binPath': '', 'defaultModel': '', 'defaultEffort': '', 'env': <String, String>{}, 'dailyBudget': ?dailyBudget},
  'spentToday': ?spentToday,
  'checkedAt': DateTime(2026, 10, 14, 9, 5, 7).millisecondsSinceEpoch,
};

Map<String, dynamic> agentJson(String id, String name, String runtime) => {
  'id': id,
  'name': name,
  'role': '',
  'enabled': true,
  'runtime': runtime,
  'model': '',
  'effort': '',
  'persona': '',
  'personaMode': 'append',
  'skills': <String>[],
  'mcpServers': <Object>[],
  'disallowedTools': <String>[],
  'env': <String, String>{},
  'workdir': '',
  'worktree': false,
  'tags': <String>[],
  'look': {'build': 'biped', 'head': 'rounded', 'body': '#fff', 'trim': '#000', 'hat': '#f00', 'eye': '#0ff', 'species': 'fox', 'outfit': 'farmer'},
};
