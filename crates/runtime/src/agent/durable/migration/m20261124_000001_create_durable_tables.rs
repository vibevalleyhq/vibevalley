use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum DurableConversation {
    Table,
    Id,
    OwnerTaskId,
    ParentId,
    ForkEntrySeq,
    HeadSeq,
    NextSeq,
    ProviderAffinity,
    MetadataJson,
    CreatedAtMs,
    UpdatedAtMs,
}

#[derive(DeriveIden)]
enum DurableEntry {
    Table,
    ConversationId,
    Seq,
    Kind,
    PayloadJson,
    CreatedAtMs,
}

#[derive(DeriveIden)]
enum DurableDocument {
    Table,
    ScopeKind,
    ScopeId,
    DocKind,
    Rev,
    StateJson,
    UpdatedAtMs,
}

#[derive(DeriveIden)]
enum DurableSubmission {
    Table,
    Id,
    ConversationId,
    RequestId,
    Kind,
    Status,
    PayloadJson,
    NotifyTaskId,
    ResultJson,
    CreatedAtMs,
    UpdatedAtMs,
}

#[derive(DeriveIden)]
enum DurableTask {
    Table,
    Id,
    ConversationId,
    OwnerTaskId,
    DedupKey,
    Kind,
    IsModelTask,
    Status,
    TerminalReason,
    RestartCount,
    RestartLimit,
    PhaseName,
    CheckpointJson,
    WakeUntilMs,
    WaitMode,
    WaitTaskIdsJson,
    WaitSignalName,
    MemoJson,
    ResultJson,
    ErrorText,
    CreatedAtMs,
    UpdatedAtMs,
}

#[derive(DeriveIden)]
enum DurableSignal {
    Table,
    Id,
    InsertSeq,
    TaskId,
    SignalName,
    SignalKey,
    PayloadJson,
    Consumed,
    ConsumedAtMs,
    CreatedAtMs,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(DurableConversation::Table)
                    .if_not_exists()
                    .col(text(DurableConversation::Id).primary_key())
                    .col(text(DurableConversation::OwnerTaskId).default(""))
                    .col(text(DurableConversation::ParentId).default(""))
                    .col(big_integer(DurableConversation::ForkEntrySeq).default(0))
                    .col(big_integer(DurableConversation::HeadSeq).default(1))
                    .col(big_integer(DurableConversation::NextSeq).default(1))
                    .col(text(DurableConversation::ProviderAffinity).default(""))
                    .col(text(DurableConversation::MetadataJson).default("{}"))
                    .col(big_integer(DurableConversation::CreatedAtMs))
                    .col(big_integer(DurableConversation::UpdatedAtMs))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_conversation_owner_idx")
                    .table(DurableConversation::Table)
                    .col(DurableConversation::OwnerTaskId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(DurableEntry::Table)
                    .if_not_exists()
                    .col(text(DurableEntry::ConversationId))
                    .col(big_integer(DurableEntry::Seq))
                    .col(text(DurableEntry::Kind))
                    .col(text(DurableEntry::PayloadJson))
                    .col(big_integer(DurableEntry::CreatedAtMs))
                    .primary_key(Index::create().col(DurableEntry::ConversationId).col(DurableEntry::Seq))
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(DurableDocument::Table)
                    .if_not_exists()
                    .col(text(DurableDocument::ScopeKind))
                    .col(text(DurableDocument::ScopeId))
                    .col(text(DurableDocument::DocKind))
                    .col(big_integer(DurableDocument::Rev))
                    .col(text(DurableDocument::StateJson))
                    .col(big_integer(DurableDocument::UpdatedAtMs))
                    .primary_key(
                        Index::create()
                            .col(DurableDocument::ScopeKind)
                            .col(DurableDocument::ScopeId)
                            .col(DurableDocument::DocKind),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(DurableSubmission::Table)
                    .if_not_exists()
                    .col(text(DurableSubmission::Id).primary_key())
                    .col(text(DurableSubmission::ConversationId))
                    .col(text(DurableSubmission::RequestId))
                    .col(text(DurableSubmission::Kind))
                    .col(text(DurableSubmission::Status))
                    .col(text(DurableSubmission::PayloadJson))
                    .col(text(DurableSubmission::NotifyTaskId).default(""))
                    .col(text(DurableSubmission::ResultJson).default("{}"))
                    .col(big_integer(DurableSubmission::CreatedAtMs))
                    .col(big_integer(DurableSubmission::UpdatedAtMs))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_submission_conv_req_uidx")
                    .table(DurableSubmission::Table)
                    .col(DurableSubmission::ConversationId)
                    .col(DurableSubmission::RequestId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(DurableTask::Table)
                    .if_not_exists()
                    .col(text(DurableTask::Id).primary_key())
                    .col(text(DurableTask::ConversationId).default(""))
                    .col(text(DurableTask::OwnerTaskId).default(""))
                    .col(text(DurableTask::DedupKey).default(""))
                    .col(text(DurableTask::Kind))
                    .col(boolean(DurableTask::IsModelTask).default(false))
                    .col(text(DurableTask::Status))
                    .col(text(DurableTask::TerminalReason).default(""))
                    .col(integer(DurableTask::RestartCount).default(0))
                    .col(integer(DurableTask::RestartLimit).default(5))
                    .col(text(DurableTask::PhaseName).default(""))
                    .col(text(DurableTask::CheckpointJson).default("{}"))
                    .col(big_integer(DurableTask::WakeUntilMs).default(0))
                    .col(text(DurableTask::WaitMode).default(""))
                    .col(text(DurableTask::WaitTaskIdsJson).default("[]"))
                    .col(text(DurableTask::WaitSignalName).default(""))
                    .col(text(DurableTask::MemoJson).default("{}"))
                    .col(text(DurableTask::ResultJson).default("{}"))
                    .col(text(DurableTask::ErrorText).default(""))
                    .col(big_integer(DurableTask::CreatedAtMs))
                    .col(big_integer(DurableTask::UpdatedAtMs))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_task_owner_dedup")
                    .table(DurableTask::Table)
                    .col(DurableTask::OwnerTaskId)
                    .col(DurableTask::DedupKey)
                    .unique()
                    .and_where(Expr::col(DurableTask::DedupKey).ne(""))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_task_owner_idx")
                    .table(DurableTask::Table)
                    .col(DurableTask::OwnerTaskId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_task_status_idx")
                    .table(DurableTask::Table)
                    .col(DurableTask::Status)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_task_conv_idx")
                    .table(DurableTask::Table)
                    .col(DurableTask::ConversationId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(DurableSignal::Table)
                    .if_not_exists()
                    .col(text(DurableSignal::Id).primary_key())
                    .col(big_integer(DurableSignal::InsertSeq))
                    .col(text(DurableSignal::TaskId))
                    .col(text(DurableSignal::SignalName))
                    .col(text(DurableSignal::SignalKey).default(""))
                    .col(text(DurableSignal::PayloadJson).default("{}"))
                    .col(boolean(DurableSignal::Consumed).default(false))
                    .col(big_integer(DurableSignal::ConsumedAtMs).default(0))
                    .col(big_integer(DurableSignal::CreatedAtMs))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_signal_task_key")
                    .table(DurableSignal::Table)
                    .col(DurableSignal::TaskId)
                    .col(DurableSignal::SignalName)
                    .col(DurableSignal::SignalKey)
                    .unique()
                    .and_where(Expr::col(DurableSignal::SignalKey).ne(""))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_signal_task_pending_idx")
                    .table(DurableSignal::Table)
                    .col(DurableSignal::TaskId)
                    .col(DurableSignal::SignalName)
                    .col(DurableSignal::Consumed)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("durable_signal_order")
                    .table(DurableSignal::Table)
                    .col(DurableSignal::InsertSeq)
                    .unique()
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in [
            DurableSignal::Table.into_iden(),
            DurableTask::Table.into_iden(),
            DurableSubmission::Table.into_iden(),
            DurableDocument::Table.into_iden(),
            DurableEntry::Table.into_iden(),
            DurableConversation::Table.into_iden(),
        ] {
            manager.drop_table(Table::drop().if_exists().table(table).to_owned()).await?;
        }
        Ok(())
    }
}
