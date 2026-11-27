use sea_orm_migration::prelude::*;
use sea_orm_migration::schema::{big_integer, big_integer_null, blob, text, text_null};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in ["artifact_suggestion", "artifact_change", "artifact_collab", "artifact_version", "artifact"] {
            manager.drop_table(Table::drop().table(Alias::new(table)).if_exists().to_owned()).await?;
        }

        manager
            .create_table(
                Table::create()
                    .table(Note::Table)
                    .if_not_exists()
                    .col(text(Note::Id).primary_key())
                    .col(text(Note::Title))
                    .col(text(Note::NoteType).check(Expr::col(Note::NoteType).is_in(["doc", "base", "canvas", "media"])))
                    .col(text_null(Note::ParentId))
                    .col(big_integer(Note::SortOrder).default(0))
                    .col(text_null(Note::ChannelId))
                    .col(text_null(Note::MessageId))
                    .col(text_null(Note::Issue))
                    .col(text(Note::ById))
                    .col(text(Note::ByName))
                    .col(big_integer(Note::Version))
                    .col(big_integer(Note::Seq).default(0))
                    .col(big_integer(Note::CreatedAt))
                    .col(big_integer(Note::UpdatedAt))
                    .foreign_key(
                        ForeignKey::create()
                            .from(Note::Table, Note::Issue)
                            .to(Issue::Table, Issue::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_by_parent")
                    .table(Note::Table)
                    .col(Note::ParentId)
                    .col(Note::SortOrder)
                    .col(Note::UpdatedAt)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_by_channel")
                    .table(Note::Table)
                    .col(Note::ChannelId)
                    .col(Note::UpdatedAt)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_by_issue")
                    .table(Note::Table)
                    .col(Note::Issue)
                    .col(Note::UpdatedAt)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_by_type")
                    .table(Note::Table)
                    .col(Note::NoteType)
                    .col(Note::UpdatedAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(NoteVersion::Table)
                    .if_not_exists()
                    .col(text(NoteVersion::NoteId))
                    .col(big_integer(NoteVersion::Version))
                    .col(text(NoteVersion::StorageId))
                    .col(big_integer(NoteVersion::Size))
                    .col(text_null(NoteVersion::Note))
                    .col(text(NoteVersion::ById))
                    .col(text(NoteVersion::ByName))
                    .col(text_null(NoteVersion::MessageId))
                    .col(big_integer(NoteVersion::CreatedAt))
                    .primary_key(Index::create().col(NoteVersion::NoteId).col(NoteVersion::Version))
                    .foreign_key(
                        ForeignKey::create()
                            .from(NoteVersion::Table, NoteVersion::NoteId)
                            .to(Note::Table, Note::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(NoteChange::Table)
                    .if_not_exists()
                    .col(text(NoteChange::NoteId))
                    .col(big_integer(NoteChange::Seq))
                    .col(text(NoteChange::Kind).check(Expr::col(NoteChange::Kind).is_in(["files"])))
                    .col(text_null(NoteChange::BatchId))
                    .col(text(NoteChange::Actor))
                    .col(text(NoteChange::Targets))
                    .col(text(NoteChange::Payload))
                    .col(big_integer(NoteChange::CreatedAt))
                    .primary_key(Index::create().col(NoteChange::NoteId).col(NoteChange::Seq))
                    .foreign_key(
                        ForeignKey::create()
                            .from(NoteChange::Table, NoteChange::NoteId)
                            .to(Note::Table, Note::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_change_by_created")
                    .table(NoteChange::Table)
                    .col(NoteChange::CreatedAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(NoteSuggestion::Table)
                    .if_not_exists()
                    .col(text(NoteSuggestion::Id).primary_key())
                    .col(text(NoteSuggestion::NoteId))
                    .col(text(NoteSuggestion::Path))
                    .col(text(NoteSuggestion::Author))
                    .col(text_null(NoteSuggestion::Origin))
                    .col(big_integer(NoteSuggestion::AtRev))
                    .col(text_null(NoteSuggestion::BaseHash))
                    .col(text(NoteSuggestion::Change))
                    .col(text_null(NoteSuggestion::CursorStart))
                    .col(text_null(NoteSuggestion::CursorEnd))
                    .col(big_integer_null(NoteSuggestion::StartOffset))
                    .col(big_integer_null(NoteSuggestion::EndOffset))
                    .col(
                        text(NoteSuggestion::Status)
                            .default("open")
                            .check(Expr::col(NoteSuggestion::Status).is_in(["open", "accepted", "rejected"])),
                    )
                    .col(big_integer(NoteSuggestion::CreatedAt))
                    .col(big_integer_null(NoteSuggestion::ResolvedAt))
                    .col(text_null(NoteSuggestion::ResolvedBy))
                    .foreign_key(
                        ForeignKey::create()
                            .from(NoteSuggestion::Table, NoteSuggestion::NoteId)
                            .to(Note::Table, Note::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_suggestion_by_note")
                    .table(NoteSuggestion::Table)
                    .col(NoteSuggestion::NoteId)
                    .col(NoteSuggestion::CreatedAt)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(NoteCollab::Table)
                    .if_not_exists()
                    .col(text(NoteCollab::NoteId).primary_key())
                    .col(blob(NoteCollab::Snapshot))
                    .col(big_integer(NoteCollab::UpdatedAt))
                    .foreign_key(
                        ForeignKey::create()
                            .from(NoteCollab::Table, NoteCollab::NoteId)
                            .to(Note::Table, Note::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(NoteLink::Table)
                    .if_not_exists()
                    .col(text(NoteLink::Id).primary_key())
                    .col(text(NoteLink::SourceKind).check(Expr::col(NoteLink::SourceKind).is_in(["note", "issue"])))
                    .col(text(NoteLink::SourceId))
                    .col(text(NoteLink::TargetKind).check(Expr::col(NoteLink::TargetKind).is_in(["note", "issue"])))
                    .col(text(NoteLink::TargetId))
                    .col(text(NoteLink::Relation).check(Expr::col(NoteLink::Relation).is_in(["link", "embed"])))
                    .col(text_null(NoteLink::Title))
                    .col(big_integer(NoteLink::CreatedAt))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_link_by_source")
                    .table(NoteLink::Table)
                    .col(NoteLink::SourceKind)
                    .col(NoteLink::SourceId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("note_link_by_target")
                    .table(NoteLink::Table)
                    .col(NoteLink::TargetKind)
                    .col(NoteLink::TargetId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in ["note_link", "note_collab", "note_suggestion", "note_change", "note_version", "note"] {
            manager.drop_table(Table::drop().table(Alias::new(table)).if_exists().to_owned()).await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Issue {
    Table,
    Id,
}

#[derive(DeriveIden)]
#[allow(clippy::enum_variant_names)]
enum Note {
    Table,
    Id,
    Title,
    NoteType,
    ParentId,
    SortOrder,
    ChannelId,
    MessageId,
    Issue,
    ById,
    ByName,
    Version,
    Seq,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum NoteVersion {
    Table,
    NoteId,
    Version,
    StorageId,
    Size,
    Note,
    ById,
    ByName,
    MessageId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum NoteChange {
    Table,
    NoteId,
    Seq,
    Kind,
    BatchId,
    Actor,
    Targets,
    Payload,
    CreatedAt,
}

#[derive(DeriveIden)]
enum NoteSuggestion {
    Table,
    Id,
    NoteId,
    Path,
    Author,
    Origin,
    AtRev,
    BaseHash,
    Change,
    CursorStart,
    CursorEnd,
    StartOffset,
    EndOffset,
    Status,
    CreatedAt,
    ResolvedAt,
    ResolvedBy,
}

#[derive(DeriveIden)]
enum NoteCollab {
    Table,
    NoteId,
    Snapshot,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum NoteLink {
    Table,
    Id,
    SourceKind,
    SourceId,
    TargetKind,
    TargetId,
    Relation,
    Title,
    CreatedAt,
}
