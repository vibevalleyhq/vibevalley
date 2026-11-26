use super::should_mount_inspector;

#[test]
fn lazy_inspector_mounts_only_when_workspace_inspector_open_and_viewport_wide() {
    assert!(!should_mount_inspector(false, true, 1440.0));
    assert!(!should_mount_inspector(true, false, 1440.0));
    assert!(!should_mount_inspector(true, true, 1039.0));
    assert!(should_mount_inspector(true, true, 1040.0));
    assert!(should_mount_inspector(true, true, 1440.0));
}
