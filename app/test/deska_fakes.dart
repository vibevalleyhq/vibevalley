import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/app/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/desk/shared/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/sprites/atlas.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final atlas = SpriteAtlas.parse(File('assets/pixel/sprites.json').readAsStringSync());

Look look({Species? species = Species.bear, Outfit? outfit = Outfit.farmer, String hat = '#e8804f'}) =>
    Look(species: species, outfit: outfit, build: Build.biped, head: Head.rounded, body: '#f3e9da', trim: '#d9774f', hat: hat, eye: '#a6f4ff');

AgentProfile agent(
  String id,
  String name, {
  String runtime = 'claude',
  String role = '',
  String persona = '',
  PersonaMode personaMode = PersonaMode.append,
  List<String> skills = const [],
  bool enabled = true,
  List<String> tags = const [],
}) => AgentProfile(
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

Memory memory(String id, String text, {String agent = 'backend', MemoryKind kind = MemoryKind.note, String? project, String? helper, double at = 0}) =>
    Memory(id: id, agent: agent, kind: kind, text: text, project: project, helper: helper, at: at, recalled: 0);

VoiceSettings voice({String greeting = '来啦！今天想种点什么？'}) => VoiceSettings(
  area: Area.uS,
  language: Language.zhCN,
  asr: const VoiceAsrAres(),
  llm: const VoiceLlmAgora(model: VoiceLlmAgoraModel.gpt41Mini),
  tts: const VoiceTtsMinimax(model: VoiceTtsMinimaxModel.speech26Turbo, voiceId: 'Chinese (Mandarin)_Gentle_Youth'),
  persona: '你是管家。',
  greeting: greeting,
  failureMessage: '我这边卡了一下，你再说一遍？',
  silenceMs: 480,
  interruptMs: 160,
  idleSeconds: 30,
);

typedef Call = ({String method, String path, Object? body});

class FakeServer {
  FakeServer({
    List<AgentProfile>? agents,
    List<Skill>? skills,
    List<RuntimeInfo>? runtimes,
    Map<String, List<Memory>>? memories,
    this.managerMemory,
    this.archive = const ArchiveListing(files: [], hits: []),
    this.archiveFiles = const {},
    this.trajectories = const {},
    this.heads = const [],
    this.settings,
    this.projects = const [],
  }) : agents = [...?agents],
       skills = [...?skills],
       runtimes = [...?runtimes],
       memories = {...?memories};

  final List<AgentProfile> agents;
  final List<Skill> skills;
  final List<RuntimeInfo> runtimes;
  final Map<String, List<Memory>> memories;
  ManagerMemory? managerMemory;
  final ArchiveListing archive;
  final Map<String, String> archiveFiles;
  final Map<String, Trajectory> trajectories;
  final List<TrajectoryHead> heads;
  SettingsStatus? settings;
  final List<ProjectSummary> projects;

  final calls = <Call>[];

  List<Call> get writes => calls.where((c) => c.method != 'GET').toList();

  late final api = VibeValleyApi(Uri.parse('http://farm.test'), MockClient(_answer));

  Future<http.Response> _answer(http.Request r) async {
    final path = r.url.path;
    final body = r.body.isEmpty ? null : jsonDecode(r.body);
    calls.add((method: r.method, path: r.url.hasQuery ? '$path?${r.url.query}' : path, body: body));
    http.Response json(Object? v, [int status = 200]) => http.Response(jsonEncode(v), status, headers: {'content-type': 'application/json; charset=utf-8'});
    final parts = path.split('/').where((p) => p.isNotEmpty).map(Uri.decodeComponent).toList();
    switch ((r.method, parts)) {
      case ('GET', ['api', 'agents']):
        return json([for (final a in agents) a.toJson()]);
      case ('PUT', ['api', 'agents', final id]):
        final a = AgentProfile.fromJson(body as Map<String, dynamic>);
        final i = agents.indexWhere((x) => x.id == id);
        if (i < 0) {
          agents.add(a);
        } else {
          agents[i] = a;
        }
        return json(a.toJson());
      case ('DELETE', ['api', 'agents', final id]):
        agents.removeWhere((a) => a.id == id);
        return http.Response('', 204);
      case ('GET', ['api', 'skills']):
        return json([for (final s in skills) s.toJson()]);
      case ('PUT', ['api', 'skills', final id]):
        final s = Skill.fromJson(body as Map<String, dynamic>);
        final i = skills.indexWhere((x) => x.id == id);
        if (i < 0) {
          skills.add(s);
        } else {
          skills[i] = s;
        }
        return json(s.toJson());
      case ('DELETE', ['api', 'skills', final id]):
        skills.removeWhere((s) => s.id == id);
        for (var i = 0; i < agents.length; i++) {
          final a = agents[i];
          if (a.skills.contains(id)) agents[i] = AgentProfile.fromJson({...a.toJson(), 'skills': a.skills.where((s) => s != id).toList()});
        }
        return http.Response('', 204);
      case ('GET', ['api', 'runtimes']):
        return json([for (final x in runtimes) x.toJson()]);
      case ('GET', ['api', 'projects']):
        return json([for (final p in projects) p.toJson()]);
      case ('GET', ['api', 'agents', final id, 'memories']):
        return json([for (final m in memories[id] ?? const <Memory>[]) m.toJson()]);
      case ('POST', ['api', 'agents', final id, 'memories']):
        final req = MemoryRequest.fromJson(body as Map<String, dynamic>);
        final m = memory('m${calls.length}', req.text, agent: id, project: req.project, at: 1);
        memories[id] = [m, ...?memories[id]];
        return json(m.toJson());
      case ('DELETE', ['api', 'agents', final id, 'memories', final mid]):
        memories[id]?.removeWhere((m) => m.id == mid);
        return http.Response('', 204);
      case ('GET', ['api', 'manager', 'memories']):
        return managerMemory == null ? json({'_tag': 'FarmMissing', 'reason': '没有'}, 404) : json(managerMemory!.toJson());
      case ('POST', ['api', 'manager', 'memories']):
        final req = MemoryRequest.fromJson(body as Map<String, dynamic>);
        final m = memory('mm${calls.length}', req.text, agent: 'foreman', at: 1);
        final mm = managerMemory!;
        managerMemory = ManagerMemory(runtime: mm.runtime, file: mm.file, memories: [m, ...mm.memories], carried: mm.carried + 1);
        return json(m.toJson());
      case ('DELETE', ['api', 'manager', 'memories', final mid]):
        final mm = managerMemory!;
        managerMemory = ManagerMemory(runtime: mm.runtime, file: mm.file, memories: mm.memories.where((m) => m.id != mid).toList(), carried: mm.carried);
        return http.Response('', 204);
      case ('GET', ['api', 'manager', 'archive']):
        final q = r.url.queryParameters['q'];
        return json(q == null ? ArchiveListing(files: archive.files, hits: const []).toJson() : archive.toJson());
      case ('GET', ['api', 'manager', 'archive', final name]):
        return json(archiveFiles[name] ?? '');
      case ('GET', ['api', 'trajectories']):
        final agent = r.url.queryParameters['agent'];
        return json([
          for (final h in heads)
            if (agent == null || h.agent == agent) h.toJson(),
        ]);
      case ('GET', ['api', 'trajectories', final id]):
        final t = trajectories[id];
        return t == null ? json({'_tag': 'FarmMissing', 'reason': '没有'}, 404) : json(t.toJson());
      case ('GET', ['api', 'settings']):
        return json(settings!.toJson());
      case ('PUT', ['api', 'settings']):
        final update = SettingsUpdate.fromJson(body as Map<String, dynamic>);
        final s = settings!;
        final v = {...s.voiceDefaults.toJson(), ...?update.voice?.toJson()};
        settings = SettingsStatus.fromJson({...s.toJson(), 'voice': v});
        return json(settings!.toJson());
      default:
        return json({'_tag': 'FarmMissing', 'reason': 'no ${r.method} $path'}, 404);
    }
  }
}

Future<void> pumpPage(WidgetTester t, FakeServer server, Widget page, {FarmState? farm, Stream<SiteEvent>? events, Size size = const Size(1600, 1200)}) async {
  t.view.physicalSize = size;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(
    ProviderScope(
      overrides: [
        deskApiProvider.overrideWithValue(server.api),
        serverProvider.overrideWithValue(_ApiOnly(server.api)),
        sideEventsProvider.overrideWith((ref) => events ?? const Stream<SiteEvent>.empty()),
        farmProvider.overrideWithValue(farm),
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

/// pumpAndSettle would wait on looping animations.
Future<void> settle(WidgetTester t) async {
  for (var i = 0; i < 6; i++) {
    await t.runAsync(() => Future<void>.delayed(Duration.zero));
    await t.pump(const Duration(milliseconds: 20));
  }
}

Future<void> typeInto(WidgetTester t, String label, String text) async {
  await t.enterText(find.descendant(of: labelled(label), matching: find.byType(EditableText)).first, text);
  await t.pump();
}

Finder labelled(String label) => find.byWidgetPredicate((w) => w is Semantics && w.properties.label == label);

class _ApiOnly implements VibeValleyServer {
  _ApiOnly(this.api);

  @override
  final VibeValleyApi api;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
