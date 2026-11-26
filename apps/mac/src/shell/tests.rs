use super::{should_mount_inspector, should_raise_workbench_overlay};

#[test]
fn lazy_inspector_mounts_only_when_workspace_inspector_open_and_viewport_wide() {
    assert!(!should_mount_inspector(false, true, 1440.0));
    assert!(!should_mount_inspector(true, false, 1440.0));
    assert!(!should_mount_inspector(true, true, 1039.0));
    assert!(should_mount_inspector(true, true, 1040.0));
    assert!(should_mount_inspector(true, true, 1440.0));
}

#[test]
fn modal_overlay_raises_workbench_only_over_native_surfaces() {
    assert!(!should_raise_workbench_overlay(false, false, false));
    assert!(!should_raise_workbench_overlay(false, true, false));
    assert!(!should_raise_workbench_overlay(false, false, true));
    assert!(!should_raise_workbench_overlay(true, false, false));
    assert!(should_raise_workbench_overlay(true, true, false));
    assert!(should_raise_workbench_overlay(true, false, true));
    assert!(should_raise_workbench_overlay(true, true, true));
}
