use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(DeriveIden)]
enum OutboxItem {
    Table,
    Id,
    Topic,
    PayloadJson,
    Status,
    Attempts,
    AvailableAt,
    CreatedAt,
    LastError,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(OutboxItem::Table)
                    .if_not_exists()
                    .col(big_pk_auto(OutboxItem::Id))
                    .col(text(OutboxItem::Topic))
                    .col(text(OutboxItem::PayloadJson))
                    .col(
                        text(OutboxItem::Status)
                            .default("pending")
                            .check(Expr::col(OutboxItem::Status).is_in(["pending", "processing", "done", "failed"])),
                    )
                    .col(big_integer(OutboxItem::Attempts).default(0))
                    .col(big_integer(OutboxItem::AvailableAt))
                    .col(big_integer(OutboxItem::CreatedAt))
                    .col(text_null(OutboxItem::LastError))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("outbox_item_claim")
                    .table(OutboxItem::Table)
                    .col(OutboxItem::Status)
                    .col(OutboxItem::AvailableAt)
                    .col(OutboxItem::Id)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("outbox_item_topic_status")
                    .table(OutboxItem::Table)
                    .col(OutboxItem::Topic)
                    .col(OutboxItem::Status)
                    .col(OutboxItem::Id)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.drop_table(Table::drop().if_exists().table(OutboxItem::Table).to_owned()).await
    }
}
