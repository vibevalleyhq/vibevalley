import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../farm/farm_page.dart';
import '../desk/agents/agent_creator_page.dart';
import '../desk/agents/agents_page.dart';
import '../desk/assets/assets_page.dart';
import '../desk/chat/chat_page.dart';
import '../desk/connectors/connectors_page.dart';
import '../desk/gate/gate_page.dart';
import '../desk/map/map_page.dart';
import '../desk/issues/issues_page.dart';
import '../desk/manager/manager_page.dart';
import '../desk/projects/projects_page.dart';
import '../desk/runtimes/runtimes_page.dart';
import '../desk/skills/skills_page.dart';
import '../desk/voice/voice_page.dart';
import 'desk.dart';

enum Place {
  chat('聊天', '频道和串', 'icon-board', '/chat'),
  issues('工单', '每次种植的全过程', 'icon-tasks', '/issues'),
  map('地图', '每个项目一座岛', 'icon-map', '/map'),
  agents('帮工', 'Agent', 'raccoon-farmer-down', '/agents'),
  runtimes('农具', 'Runtime', 'machine-tractor', '/runtimes'),
  skills('技能书', '技能', 'icon-skillbook', '/skills'),
  connectors('连接器', '微信 飞书 QQ', 'icon-pigeon', '/connectors'),
  projects('项目', '代码库', 'icon-deed', '/projects'),
  voice('声音', 'Agora 语音', 'act-speaking_text', '/voice'),
  gate('院门', '手机和别的电脑', 'icon-shed', '/gate'),
  assets('图鉴', '素材', 'icon-log', '/assets');

  const Place(this.label, this.hint, this.icon, this.path);
  final String label;
  final String hint;
  final String icon;
  final String path;

  static Place? of(String location) {
    if (location.startsWith('/manager')) return Place.agents;
    for (final p in values) {
      if (location == p.path || location.startsWith('${p.path}/')) return p;
    }
    return null;
  }
}

final router = GoRouter(
  routes: [
    GoRoute(path: '/pixel', redirect: (_, _) => '/'),
    // The farm stays mounted beneath the desk pages, hidden and paused, so helpers keep their places.
    ShellRoute(
      builder: (_, state, child) => _KeepFarm(onFarm: state.uri.path == '/', child: child),
      routes: [
        GoRoute(path: '/', builder: (_, _) => const SizedBox.shrink()),
        ShellRoute(
          builder: (_, state, child) => Desk(place: Place.of(state.uri.path), child: child),
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
              path: '/assets/cursors',
              builder: (_, _) => const AssetsPage(shelf: 'cursors'),
            ),
            GoRoute(
              path: '/assets/sounds',
              builder: (_, _) => const AssetsPage(shelf: 'sounds'),
            ),
            GoRoute(
              path: '/assets',
              builder: (_, _) => const AssetsPage(shelf: 'sprites'),
            ),
            GoRoute(
              path: '/assets/:id',
              builder: (_, s) => AssetsPage(shelf: 'sprites', id: s.pathParameters['id']),
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
