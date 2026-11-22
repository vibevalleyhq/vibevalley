-- name: Artifact :one
select a.id, a.title, a.body, a.artifact_type, a.is_default, a.display, a.channel_id, a.message_id, a.issue, a.by_id, a.by_name, a.version, a.seq,
  a.created_at, a.updated_at, m.channel_id as said_channel, m.number as said_number
  from artifact a left join channel_message m on m.id = a.message_id where a.id = ?1;

-- name: DefaultDesignSystemArtifact :one
select a.id, a.title, a.body, a.artifact_type, a.is_default, a.display, a.channel_id, a.message_id, a.issue, a.by_id, a.by_name, a.version, a.seq,
  a.created_at, a.updated_at, m.channel_id as said_channel, m.number as said_number
  from artifact a left join channel_message m on m.id = a.message_id
  where a.artifact_type = 'design-system' and a.is_default = 1
  limit 1;

-- name: ClearDefaultDesignSystem :exec
update artifact set is_default = 0, updated_at = ?1 where is_default = 1;

-- name: SetArtifactDefault :exec
update artifact set is_default = ?2, updated_at = ?3 where id = ?1;

-- name: ArtifactsInChannel :many
select a.id, a.title, a.body, a.artifact_type, a.is_default, a.display, a.channel_id, a.message_id, a.issue, a.by_id, a.by_name, a.version, a.seq,
  a.created_at, a.updated_at, m.channel_id as said_channel, m.number as said_number
  from artifact a left join channel_message m on m.id = a.message_id where a.channel_id = ?1 order by a.updated_at desc, a.id;

-- name: ArtifactsForIssue :many
select a.id, a.title, a.body, a.artifact_type, a.is_default, a.display, a.channel_id, a.message_id, a.issue, a.by_id, a.by_name, a.version, a.seq,
  a.created_at, a.updated_at, m.channel_id as said_channel, m.number as said_number
  from artifact a left join channel_message m on m.id = a.message_id where a.issue = ?1 order by a.updated_at desc, a.id;

-- name: Artifacts :many
select a.id, a.title, a.body, a.artifact_type, a.is_default, a.display, a.channel_id, a.message_id, a.issue, a.by_id, a.by_name, a.version, a.seq,
  a.created_at, a.updated_at, m.channel_id as said_channel, m.number as said_number
  from artifact a left join channel_message m on m.id = a.message_id order by a.updated_at desc, a.id limit ?1;

-- name: AddArtifact :exec
insert into artifact (id, title, body, artifact_type, is_default, display, channel_id, issue, by_id, by_name, version, seq, created_at, updated_at)
  values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?12);

-- name: ArtifactSaid :exec
update artifact set message_id = ?2 where id = ?1;

-- name: ArtifactVersioned :exec
update artifact set version = ?2, updated_at = ?3 where id = ?1;

-- name: ArtifactAccepted :exec
update artifact set seq = ?2, updated_at = ?3 where id = ?1;

-- name: ArtifactRenamed :exec
update artifact set title = ?2, updated_at = ?3 where id = ?1;

-- name: ArtifactShown :exec
update artifact set display = ?2, updated_at = ?3 where id = ?1 and body = 'html';

-- name: DeleteArtifact :exec
delete from artifact where id = ?1;

-- name: AddVersion :exec
insert into artifact_version (artifact_id, version, attachment_id, size, note, by_id, by_name, created_at)
  values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);

-- name: VersionAnnounced :exec
update artifact_version set message_id = ?3 where artifact_id = ?1 and version = ?2;

-- name: Versions :many
select v.version, v.attachment_id, v.size, v.note, v.by_id, v.by_name, v.created_at, m.channel_id as message_channel, m.number as message_number
  from artifact_version v left join channel_message m on m.id = v.message_id where v.artifact_id = ?1 order by v.version;

-- name: Version :one
select v.version, v.attachment_id, v.size, v.note, v.by_id, v.by_name, v.created_at, m.channel_id as message_channel, m.number as message_number
  from artifact_version v left join channel_message m on m.id = v.message_id where v.artifact_id = ?1 and v.version = ?2;

-- name: Blocks :many
select id, artifact_id, parent_id, order_key, type, attrs, spans, rev, deleted, updated_by, updated_at
  from artifact_block where artifact_id = ?1 order by order_key, id;

-- name: BlockOwner :one
select artifact_id from artifact_block where id = ?1;

-- name: PutBlock :exec
insert into artifact_block (id, artifact_id, parent_id, order_key, type, attrs, spans, rev, deleted, updated_by, updated_at)
  values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  on conflict (id) do update set parent_id = excluded.parent_id, order_key = excluded.order_key, type = excluded.type,
  attrs = excluded.attrs, spans = excluded.spans, rev = excluded.rev, deleted = excluded.deleted,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;

-- name: AddRevision :exec
insert into artifact_block_revision (id, block_id, rev, spans, actor, kind, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7);

-- name: Revision :one
select spans from artifact_block_revision where block_id = ?1 and rev = ?2 and kind = 'normal'
  order by created_at desc limit 1;

-- name: PruneChanges :exec
delete from artifact_change where created_at < ?1;

-- name: PruneRevisions :exec
delete from artifact_block_revision where created_at < ?1;

-- name: ChangeByBatch :one
select artifact_id, seq, batch_id, block_ids, results from artifact_change where batch_id = ?1;

-- name: AddChange :exec
insert into artifact_change (artifact_id, seq, batch_id, actor, block_ids, results, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7);

-- name: ChangesAfter :many
select artifact_id, seq, batch_id, block_ids, results from artifact_change
  where artifact_id = ?1 and seq > ?2 order by seq limit ?3;

-- name: AddSuggestion :exec
insert into artifact_suggestion (id, artifact_id, block_id, author, origin, at_rev, change, cursor_start, cursor_end, start_offset, end_offset, anchor_text, replacement_text, status, created_at)
  values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'open', ?14);

-- name: UpdateSuggestion :exec
update artifact_suggestion
  set at_rev = ?2, change = ?3, cursor_start = ?4, cursor_end = ?5, start_offset = ?6, end_offset = ?7, anchor_text = ?8, replacement_text = ?9
  where id = ?1 and status = 'open';

-- name: Suggestion :one
select id, artifact_id, block_id, author, origin, at_rev, change, cursor_start, cursor_end, start_offset, end_offset, anchor_text, replacement_text, status, created_at, resolved_at, resolved_by from artifact_suggestion where id = ?1;

-- name: Suggestions :many
select id, artifact_id, block_id, author, origin, at_rev, change, cursor_start, cursor_end, start_offset, end_offset, anchor_text, replacement_text, status, created_at, resolved_at, resolved_by from artifact_suggestion where artifact_id = ?1 order by created_at, id limit ?2;

-- name: ResolveSuggestion :exec
update artifact_suggestion set status = ?2, resolved_at = ?3, resolved_by = ?4 where id = ?1 and status = 'open';

-- name: ArtifactEntries :many
select artifact_id, path, kind, mime, value, attachment_id, size, rev, updated_by, updated_at
  from artifact_entry where artifact_id = ?1 order by path;

-- name: ArtifactEntriesByPrefix :many
select artifact_id, path, kind, mime, value, attachment_id, size, rev, updated_by, updated_at
  from artifact_entry where artifact_id = ?1 and path like ?2 order by path;

-- name: ArtifactEntry :one
select artifact_id, path, kind, mime, value, attachment_id, size, rev, updated_by, updated_at
  from artifact_entry where artifact_id = ?1 and path = ?2;

-- name: ArtifactEntryCount :one
select count(*) as n from artifact_entry where artifact_id = ?1;

-- name: UpsertArtifactEntry :exec
insert into artifact_entry (artifact_id, path, kind, mime, value, attachment_id, size, rev, updated_by, updated_at)
  values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  on conflict (artifact_id, path) do update set
    kind = excluded.kind,
    mime = excluded.mime,
    value = excluded.value,
    attachment_id = excluded.attachment_id,
    size = excluded.size,
    rev = excluded.rev,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

-- name: DeleteArtifactEntry :exec
delete from artifact_entry where artifact_id = ?1 and path = ?2;

-- name: AddArtifactEntryChange :exec
insert into artifact_entry_change (artifact_id, seq, actor, paths, deleted, created_at)
  values (?1, ?2, ?3, ?4, ?5, ?6);

-- name: ArtifactEntryChangesAfter :many
select seq, paths, deleted
  from artifact_entry_change where artifact_id = ?1 and seq > ?2 order by seq limit ?3;

-- name: PruneArtifactEntryChanges :exec
delete from artifact_entry_change where created_at < ?1;

-- name: ArtifactCollab :one
select snapshot from artifact_collab where artifact_id = ?1;

-- name: UpsertArtifactCollab :exec
insert into artifact_collab (artifact_id, snapshot, updated_at)
  values (?1, ?2, ?3)
  on conflict (artifact_id) do update set
    snapshot = excluded.snapshot,
    updated_at = excluded.updated_at;
