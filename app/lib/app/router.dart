import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../farm/farm_page.dart';
import '../workbench/agents/agent_creator_page.dart';
import '../workbench/agents/agents_page.dart';
import '../workbench/catalog/catalog_page.dart';
import '../workbench/chat/chat_page.dart';
import '../workbench/connectors/connectors_page.dart';
import '../workbench/gate/gate_page.dart';
import '../workbench/map/map_page.dart';
import '../workbench/issues/issues_page.dart';
import '../workbench/manager/manager_page.dart';
import '../workbench/projects/projects_page.dart';
import '../workbench/runtimes/runtimes_page.dart';
import '../workbench/skills/skills_page.dart';
import '../workbench/voice/voice_page.dart';
import '../workbench/workbench_shell.dart';
import '../workbench/places.dart';

final router = GoRouter(
  routes: [
    GoRoute(path: '/pixel', redirect: (_, _) => '/'),
    // The farm stays mounted beneath the workbench pages, hidden and paused, so helpers keep their places.
    ShellRoute(
      builder: (_, state, child) => _KeepFarm(onFarm: state.uri.path == '/', child: child),
      routes: [
        GoRoute(path: '/', builder: (_, _) => const SizedBox.shrink()),
        ShellRoute(
          builder: (_, state, child) => Workbench(place: Place.of(state.uri.path), child: child),
          routes: [
            GoRoute(path: '/chat', builder: (_, _) => const ChatPage()),
            GoRoute(
              path: '/chat/:id',
              builder: (_, s) => ChatPage(id: s.pathParameters['id']),
            ),
            GoRoute(path: '/issues', builder: (_, _) => const IssuesPage()),
            GoRoute(
              path: '/issues/:id',
              builder: (_, s) => IssuesPage(id: s.pathParameters['id'], project: s.uri.queryParameters['project']),
            ),
            GoRoute(path: '/map', builder: (_, _) => const MapPage()),
            GoRoute(
              path: '/map/:project',
              builder: (_, s) => MapPage(project: s.pathParameters['project']),
            ),
            GoRoute(path: '/agents', builder: (_, _) => const AgentsPage()),
            GoRoute(
              path: '/agents/:id',
              builder: (_, s) => AgentCreatorPage(id: s.pathParameters['id']!, runtime: s.uri.queryParameters['runtime']),
            ),
            GoRoute(path: '/manager', builder: (_, _) => const ManagerPage()),
            GoRoute(
              path: '/manager/:tab',
              builder: (_, s) => ManagerPage(tab: s.pathParameters['tab']),
            ),
            GoRoute(path: '/runtimes', builder: (_, _) => const RuntimesPage()),
            GoRoute(
              path: '/runtimes/:id',
              builder: (_, s) => RuntimesPage(id: s.pathParameters['id']),
            ),
            GoRoute(path: '/skills', builder: (_, _) => const SkillsPage()),
            GoRoute(
              path: '/skills/:id',
              builder: (_, s) => SkillsPage(id: s.pathParameters['id']),
            ),
            GoRoute(path: '/connectors', builder: (_, _) => const ConnectorsPage()),
            GoRoute(
              path: '/connectors/:id',
              builder: (_, s) => ConnectorsPage(id: s.pathParameters['id']),
            ),
            GoRoute(path: '/projects', builder: (_, _) => const ProjectsPage()),
            GoRoute(
              path: '/projects/:id',
              builder: (_, s) => ProjectsPage(id: s.pathParameters['id']),
            ),
            GoRoute(path: '/voice', builder: (_, _) => const VoiceSettingsPage()),
            GoRoute(path: '/gate', builder: (_, _) => const GatePage()),
            GoRoute(
              path: '/catalog/cursors',
              builder: (_, _) => const CatalogPage(shelf: 'cursors'),
            ),
            GoRoute(
              path: '/catalog/sounds',
              builder: (_, _) => const CatalogPage(shelf: 'sounds'),
            ),
            GoRoute(
              path: '/catalog',
              builder: (_, _) => const CatalogPage(shelf: 'sprites'),
            ),
            GoRoute(
              path: '/catalog/:id',
              builder: (_, s) => CatalogPage(shelf: 'sprites', id: s.pathParameters['id']),
            ),
          ],
        ),
      ],
    ),
  ],
  errorBuilder: (_, _) => const _GoHome(),
);

class _KeepFarm extends StatelessWidget {
  const _KeepFarm({required this.onFarm, required this.child});
  final bool onFarm;
  final Widget child;

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      Offstage(
        offstage: !onFarm,
        child: TickerMode(enabled: onFarm, child: const FarmPage()),
      ),
      if (!onFarm) child,
    ],
  );
}

class _GoHome extends StatelessWidget {
  const _GoHome();

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (context.mounted) context.go('/');
    });
    return const SizedBox.shrink();
  }
}
