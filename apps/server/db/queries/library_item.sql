-- The library: kept attachments and where each first came from (library/library.ts).

-- name: LibraryItems :many
-- bound: at most n; kind and top ('' for any) filter by origin and by media type, text by words in the name;
-- sort is recent (the latest arrival first), name or size (the biggest first), then the latest arrival.
select i.attachment_id, i.origin, i.added_at, i.last_at, a.name, a.type, a.size
from library_item i join attachment a on a.id = i.attachment_id
where (sqlc.arg(kind)::text = '' or i.kind::text = sqlc.arg(kind)::text)
  and (sqlc.arg(top)::text = ''
    or (sqlc.arg(top)::text = 'other' and split_part(a.type, '/', 1) not in ('image', 'audio', 'video'))
    or split_part(a.type, '/', 1) = sqlc.arg(top)::text)
  and (sqlc.arg(text)::text = '' or strpos(lower(a.name), lower(sqlc.arg(text)::text)) > 0)
order by
  case when sqlc.arg(sort)::text = 'name' then lower(a.name) end,
  case when sqlc.arg(sort)::text = 'size' then a.size end desc,
  i.last_at desc, i.attachment_id
limit sqlc.arg(n)::int;

-- name: LibraryItem :one
select i.attachment_id, i.origin, i.added_at, i.last_at, a.name, a.type, a.size
from library_item i join attachment a on a.id = i.attachment_id
where i.attachment_id = sqlc.arg(id);

-- name: AddLibraryItem :exec
insert into library_item (attachment_id, kind, origin, added_at, last_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(origin), sqlc.arg(at), sqlc.arg(at))
on conflict (attachment_id) do update set last_at = greatest(library_item.last_at, excluded.last_at);

-- name: KnownLibraryItem :exec
insert into library_item (attachment_id, kind, origin, added_at, last_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(origin), sqlc.arg(at), sqlc.arg(at))
on conflict (attachment_id) do nothing;

-- name: RemoveLibraryItem :exec
delete from library_item where attachment_id = sqlc.arg(id);
