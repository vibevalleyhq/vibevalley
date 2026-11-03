-- name: SpendForDay :many
-- bound: one row per runtime for one local day.
select runtime, cny from runtime_spend where day = sqlc.arg(day);

-- name: AddSpend :exec
insert into runtime_spend (day, runtime, cny) values (sqlc.arg(day), sqlc.arg(runtime), sqlc.arg(cny))
on conflict (day, runtime) do update set cny = runtime_spend.cny + excluded.cny;
