//! Parser for `git status --porcelain=v2 --branch -z`.

use crate::cmd::path_from_bytes;
use crate::{Change, GitError, Result, Status, StatusEntry};

fn change(code: u8) -> Change {
    match code {
        b'M' => Change::Modified,
        b'A' => Change::Added,
        b'D' => Change::Deleted,
        b'R' => Change::Renamed,
        b'C' => Change::Copied,
        b'T' => Change::TypeChanged,
        b'U' => Change::Conflicted,
        _ => Change::Unmodified,
    }
}

/// The path is the last of `fields` space-separated fields and may itself
/// contain spaces.
fn nth_field(record: &[u8], fields: usize) -> Result<&[u8]> {
    record
        .splitn(fields, |b| *b == b' ')
        .nth(fields - 1)
        .ok_or_else(|| GitError::Parse(format!("status record: {}", String::from_utf8_lossy(record))))
}

fn xy(record: &[u8]) -> Result<(u8, u8)> {
    match record {
        [_, b' ', x, y, b' ', ..] => Ok((*x, *y)),
        _ => Err(GitError::Parse(format!("status record: {}", String::from_utf8_lossy(record)))),
    }
}

pub(crate) fn parse(output: &[u8]) -> Result<Status> {
    let mut status = Status::default();
    let mut records = output.split(|b| *b == 0);
    while let Some(record) = records.next() {
        let Some(kind) = record.first() else { continue };
        match kind {
            b'#' => {
                let line = String::from_utf8_lossy(record);
                let mut parts = line.splitn(3, ' ');
                let (key, value) = (parts.nth(1).unwrap_or(""), parts.next().unwrap_or(""));
                match key {
                    "branch.oid" if value != "(initial)" => status.head = Some(value.to_string()),
                    "branch.head" if value != "(detached)" => status.branch = Some(value.to_string()),
                    "branch.upstream" => status.upstream = Some(value.to_string()),
                    "branch.ab" => {
                        for part in value.split(' ') {
                            if let Some(n) = part.strip_prefix('+') {
                                status.ahead = n.parse().unwrap_or(0);
                            } else if let Some(n) = part.strip_prefix('-') {
                                status.behind = n.parse().unwrap_or(0);
                            }
                        }
                    }
                    _ => {}
                }
            }
            b'1' => {
                let (x, y) = xy(record)?;
                status.entries.push(StatusEntry {
                    path: path_from_bytes(nth_field(record, 9)?),
                    orig_path: None,
                    index: change(x),
                    worktree: change(y),
                });
            }
            b'2' => {
                let (x, y) = xy(record)?;
                let path = path_from_bytes(nth_field(record, 10)?);
                let orig = records.next().ok_or_else(|| GitError::Parse("rename record without origin".into()))?;
                status.entries.push(StatusEntry {
                    path,
                    orig_path: Some(path_from_bytes(orig)),
                    index: change(x),
                    worktree: change(y),
                });
            }
            b'u' => status.entries.push(StatusEntry {
                path: path_from_bytes(nth_field(record, 11)?),
                orig_path: None,
                index: Change::Conflicted,
                worktree: Change::Conflicted,
            }),
            b'?' | b'!' => {
                let path = record.get(2..).unwrap_or_default();
                status.entries.push(StatusEntry {
                    path: path_from_bytes(path),
                    orig_path: None,
                    index: Change::Unmodified,
                    worktree: if *kind == b'?' { Change::Untracked } else { Change::Ignored },
                });
            }
            _ => {}
        }
    }
    Ok(status)
}
