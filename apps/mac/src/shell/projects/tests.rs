use std::path::PathBuf;

use vibevalley_files::{FsChange, FsChangeKind};

use super::git::coalesce_fs_batches;

#[test]
fn coalesce_fs_batches_merges_projects_and_deduplicates_paths() {
    let p1 = PathBuf::from("/repo/src/main.rs");
    let p2 = PathBuf::from("/repo/src/lib.rs");
    let p3 = PathBuf::from("/other/README.md");
    let batches = vec![
        (
            1,
            vec![
                FsChange {
                    path: p1.clone(),
                    kind: FsChangeKind::Modified,
                },
                FsChange {
                    path: p1.clone(),
                    kind: FsChangeKind::Modified,
                },
            ],
        ),
        (
            2,
            vec![FsChange {
                path: p3.clone(),
                kind: FsChangeKind::Created,
            }],
        ),
        (
            1,
            vec![
                FsChange {
                    path: p1.clone(),
                    kind: FsChangeKind::Modified,
                },
                FsChange {
                    path: p2.clone(),
                    kind: FsChangeKind::Created,
                },
            ],
        ),
    ];

    let coalesced = coalesce_fs_batches(batches);
    assert_eq!(coalesced.len(), 2);
    assert_eq!(coalesced[0].0, 1);
    assert_eq!(coalesced[0].1.len(), 2);
    assert_eq!(coalesced[1].0, 2);
    assert_eq!(coalesced[1].1.len(), 1);
}
