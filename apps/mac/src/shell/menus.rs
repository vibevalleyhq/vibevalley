use gpui::KeyBinding;
use vibevalley_protocol::{HostPaletteCommand, HostPaletteItem};

use crate::hosted::frames;

gpui::actions!(
    shell,
    [
        OpenAbout,
        OpenSettings,
        Hide,
        HideOthers,
        ShowAll,
        EditUndo,
        EditRedo,
        EditCut,
        EditCopy,
        EditPaste,
        EditSelectAll,
        ToggleFullScreen,
        CloseWindow,
        ActivateProject1,
        ActivateProject2,
        ActivateProject3,
        ActivateProject4,
        ActivateProject5,
        ActivateProject6,
        ActivateProject7,
        ActivateProject8,
        ActivateProject9,
        GoToFile,
        CommandPalette,
        SearchProject,
        NewTerminal,
        NewChat,
        CloseTab,
        SplitRight,
        SplitDown,
        NextTab,
        PrevTab,
        FocusNextGroup,
        ClosePalette,
        ZoomIn,
        ZoomOut,
        ZoomReset,
        ToggleSidebar,
        ToggleTheme,
        ToggleDevtools,
        Quit,
    ]
);

pub fn update_menus(cx: &mut gpui::App) {
    use gpui::{Menu, MenuItem, OsAction, SystemMenuType};
    use vibevalley_i18n::t;
    let app = [("app", "VibeValley".into())];
    let mut view_items = vec![
        MenuItem::action(t("desktop.menu.toggleSidebar", &[]), ToggleSidebar),
        MenuItem::action(t("desktop.menu.toggleTheme", &[]), ToggleTheme),
    ];
    if super::devtools_enabled() {
        view_items.push(MenuItem::action(t("desktop.menu.toggleDevtools", &[]), ToggleDevtools));
    }
    view_items.extend([
        MenuItem::separator(),
        MenuItem::action(t("desktop.menu.resetZoom", &[]), ZoomReset),
        MenuItem::action(t("desktop.menu.zoomIn", &[]), ZoomIn),
        MenuItem::action(t("desktop.menu.zoomOut", &[]), ZoomOut),
        MenuItem::separator(),
        MenuItem::action(t("desktop.menu.fullScreen", &[]), ToggleFullScreen),
    ]);
    cx.set_menus(vec![
        Menu::new("VibeValley").items([
            MenuItem::action(t("desktop.menu.about", &app), OpenAbout),
            MenuItem::separator(),
            MenuItem::action(t("desktop.menu.settings", &[]), OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action(t("desktop.menu.hide", &app), Hide),
            MenuItem::action(t("desktop.menu.hideOthers", &[]), HideOthers),
            MenuItem::action(t("desktop.menu.unhide", &[]), ShowAll),
            MenuItem::separator(),
            MenuItem::action(t("desktop.menu.quit", &app), Quit),
        ]),
        Menu::new(t("desktop.menu.edit", &[])).items([
            MenuItem::os_action(t("desktop.menu.undo", &[]), EditUndo, OsAction::Undo),
            MenuItem::os_action(t("desktop.menu.redo", &[]), EditRedo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action(t("desktop.menu.cut", &[]), EditCut, OsAction::Cut),
            MenuItem::os_action(t("desktop.menu.copy", &[]), EditCopy, OsAction::Copy),
            MenuItem::os_action(t("desktop.menu.paste", &[]), EditPaste, OsAction::Paste),
            MenuItem::os_action(t("desktop.menu.selectAll", &[]), EditSelectAll, OsAction::SelectAll),
        ]),
        Menu::new(t("desktop.menu.view", &[])).items(view_items),
        Menu::new(t("desktop.menu.window", &[])).items([
            MenuItem::action(t("desktop.menu.newChat", &[]), NewChat),
            MenuItem::separator(),
            MenuItem::action(t("desktop.menu.close", &[]), CloseWindow),
            MenuItem::action(t("desktop.menu.closeTab", &[]), CloseTab),
        ]),
    ]);
}

pub fn bind_keys(cx: &mut gpui::App) {
    cx.bind_keys([
        // Attached to no element so keyboard presses pass through to focused views, while NSMenu shows key equivalents.
        KeyBinding::new("cmd-z", EditUndo, Some("EditMenu")),
        KeyBinding::new("cmd-shift-z", EditRedo, Some("EditMenu")),
        KeyBinding::new("cmd-x", EditCut, Some("EditMenu")),
        KeyBinding::new("cmd-c", EditCopy, Some("EditMenu")),
        KeyBinding::new("cmd-v", EditPaste, Some("EditMenu")),
        KeyBinding::new("cmd-a", EditSelectAll, Some("EditMenu")),
        KeyBinding::new("cmd-,", OpenSettings, Some("Shell")),
        KeyBinding::new("cmd-k", CommandPalette, Some("Shell")),
        KeyBinding::new("cmd-shift-p", CommandPalette, Some("Shell")),
        KeyBinding::new("cmd-h", Hide, Some("Shell")),
        KeyBinding::new("cmd-alt-h", HideOthers, Some("Shell")),
        KeyBinding::new("cmd-w", CloseWindow, Some("Shell")),
        KeyBinding::new("cmd-=", ZoomIn, Some("Shell")),
        KeyBinding::new("cmd-+", ZoomIn, Some("Shell")),
        KeyBinding::new("cmd--", ZoomOut, Some("Shell")),
        KeyBinding::new("cmd-0", ZoomReset, Some("Shell")),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, Some("Shell")),
        KeyBinding::new("shift-alt-d", ToggleDevtools, Some("Shell")),
        KeyBinding::new("cmd-q", Quit, Some("Shell")),
        // Workspace-only keys: active only inside `/workspace`, never stealing shortcuts from workbench text inputs.
        KeyBinding::new("cmd-1", ActivateProject1, Some("Workspace")),
        KeyBinding::new("cmd-2", ActivateProject2, Some("Workspace")),
        KeyBinding::new("cmd-3", ActivateProject3, Some("Workspace")),
        KeyBinding::new("cmd-4", ActivateProject4, Some("Workspace")),
        KeyBinding::new("cmd-5", ActivateProject5, Some("Workspace")),
        KeyBinding::new("cmd-6", ActivateProject6, Some("Workspace")),
        KeyBinding::new("cmd-7", ActivateProject7, Some("Workspace")),
        KeyBinding::new("cmd-8", ActivateProject8, Some("Workspace")),
        KeyBinding::new("cmd-9", ActivateProject9, Some("Workspace")),
        KeyBinding::new("cmd-b", ToggleSidebar, Some("Workspace")),
        KeyBinding::new("cmd-p", GoToFile, Some("Workspace")),
        KeyBinding::new("cmd-shift-f", SearchProject, Some("Workspace")),
        KeyBinding::new("cmd-t", NewTerminal, Some("Workspace")),
        KeyBinding::new("cmd-shift-t", NewChat, Some("Workspace")),
        KeyBinding::new("cmd-w", CloseTab, Some("Workspace")),
        KeyBinding::new("cmd-d", SplitRight, Some("Workspace")),
        KeyBinding::new("cmd-shift-d", SplitDown, Some("Workspace")),
        KeyBinding::new("cmd-shift-]", NextTab, Some("Workspace")),
        KeyBinding::new("cmd-shift-[", PrevTab, Some("Workspace")),
        KeyBinding::new("cmd-`", FocusNextGroup, Some("Workspace")),
        KeyBinding::new("escape", ClosePalette, Some("Palette")),
        // Terminal-only keys: outside a terminal Cmd+C/V belong to the focused view.
        KeyBinding::new("cmd-c", crate::terminal::Copy, Some("Terminal")),
        KeyBinding::new("cmd-v", crate::terminal::Paste, Some("Terminal")),
        KeyBinding::new("cmd-k", crate::terminal::Clear, Some("Terminal")),
        KeyBinding::new("shift-pageup", crate::terminal::ScrollPageUp, Some("Terminal")),
        KeyBinding::new("shift-pagedown", crate::terminal::ScrollPageDown, Some("Terminal")),
        KeyBinding::new("shift-end", crate::terminal::ScrollToBottom, Some("Terminal")),
    ]);
    update_menus(cx);
}

pub(super) fn shell_palette_commands() -> Vec<HostPaletteItem> {
    let cmd = |id: &str, label: &str, detail: &str, group: &str, shortcut: Option<&str>| {
        HostPaletteItem::Command(HostPaletteCommand {
            id: id.to_string(),
            label: label.to_string(),
            detail: Some(detail.to_string()),
            group: group.to_string(),
            shortcut: shortcut.map(str::to_string),
        })
    };
    let mut items = vec![
        cmd("nav.workspace", "前往工作区", "/workspace", "导航", None),
        cmd("nav.chat", "前往对话", "/chat", "导航", None),
        cmd("nav.issues", "前往任务", "/issues", "导航", None),
        cmd("nav.content", "前往内容", "/library", "导航", None),
        cmd("nav.team", "前往专家", "/agents", "导航", None),
        cmd("nav.runtimes", "前往引擎", "/runtimes", "导航", None),
        cmd("nav.repos", "前往仓库", "/repos", "导航", None),
        cmd("nav.farm", "前往农场", "/farm", "导航", None),
        cmd("nav.settings", "前往设置", "/settings", "导航", Some("mod+,")),
        cmd("theme.dark", "切换主题：深色", "dark", "外观", None),
        cmd("theme.light", "切换主题：浅色", "light", "外观", None),
        cmd("theme.system", "切换主题：跟随系统", "system", "外观", None),
        cmd("inspector.toggle", "切换右侧检查器", "inspector", "视图", None),
    ];
    items.extend(frames::palette_commands());
    items
}
