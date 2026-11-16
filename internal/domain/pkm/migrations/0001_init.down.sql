DROP TABLE IF EXISTS pkm_vectors;
DROP TABLE IF EXISTS _vec_pkm_vectors;
DROP TABLE IF EXISTS vector_storage;
DROP TABLE IF EXISTS pkm_notes_fts;

DROP INDEX IF EXISTS pkm_links_block_idx;
DROP INDEX IF EXISTS pkm_links_target_idx;
DROP INDEX IF EXISTS pkm_links_source_idx;
DROP TABLE IF EXISTS pkm_links;

DROP INDEX IF EXISTS pkm_blocks_path_idx;
DROP TABLE IF EXISTS pkm_blocks;

DROP INDEX IF EXISTS pkm_aliases_path_idx;
DROP TABLE IF EXISTS pkm_aliases;

DROP INDEX IF EXISTS pkm_notes_tier_idx;
DROP INDEX IF EXISTS pkm_notes_slug_idx;
DROP TABLE IF EXISTS pkm_notes;
