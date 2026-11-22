use gpui::KeyBinding;
use serde_json::{Value, json};

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
        Quit,
    ]
);

pub fn update_menus(cx: &mut gpui::App) {
    use gpui::{Menu, MenuItem, OsAction, SystemMenuType};
    use vibevalley_i18n::t;
    let app = [("app", "VibeValley".into())];
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
        Menu::new(t("desktop.menu.view", &[])).items([
            MenuItem::action(t("desktop.menu.toggleSidebar", &[]), ToggleSidebar),
            MenuItem::action(t("desktop.menu.toggleTheme", &[]), ToggleTheme),
            MenuItem::separator(),
            MenuItem::action(t("desktop.menu.resetZoom", &[]), ZoomReset),
            MenuItem::action(t("desktop.menu.zoomIn", &[]), ZoomIn),
            MenuItem::action(t("desktop.menu.zoomOut", &[]), ZoomOut),
            MenuItem::separator(),
            MenuItem::action(t("desktop.menu.fullScreen", &[]), ToggleFullScreen),
        ]),
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

pub(super) fn shell_palette_commands() -> Vec<Value> {
    let mut items = vec![
        json!({ "id": "nav.workspace", "label": "前往工作区", "detail": "/workspace", "group": "导航" }),
        json!({ "id": "nav.chat", "label": "前往对话", "detail": "/chat", "group": "导航" }),
        json!({ "id": "nav.issues", "label": "前往任务", "detail": "/issues", "group": "导航" }),
        json!({ "id": "nav.content", "label": "前往内容", "detail": "/library", "group": "导航" }),
        json!({ "id": "nav.pkm", "label": "前往笔记", "detail": "/pkm", "group": "导航" }),
        json!({ "id": "nav.team", "label": "前往团队", "detail": "/agents", "group": "导航" }),
        json!({ "id": "nav.runtimes", "label": "前往引擎", "detail": "/runtimes", "group": "导航" }),
        json!({ "id": "nav.repos", "label": "前往仓库", "detail": "/repos", "group": "导航" }),
        json!({ "id": "nav.catalog", "label": "前往素材图鉴", "detail": "/catalog", "group": "导航" }),
        json!({ "id": "nav.farm", "label": "前往农场", "detail": "/farm", "group": "导航" }),
        json!({ "id": "nav.settings", "label": "前往设置", "detail": "/settings", "group": "导航", "shortcut": "mod+," }),
        json!({ "id": "theme.dark", "label": "切换主题：深色", "detail": "dark", "group": "外观" }),
        json!({ "id": "theme.light", "label": "切换主题：浅色", "detail": "light", "group": "外观" }),
        json!({ "id": "theme.system", "label": "切换主题：跟随系统", "detail": "system", "group": "外观" }),
        json!({ "id": "inspector.toggle", "label": "切换右侧检查器", "detail": "inspector", "group": "视图" }),
    ];
    items.extend(frames::palette_commands());
    items
}
