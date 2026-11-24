use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "terminals")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub project_id: i64,
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub ord: i64,
    pub cwd: String,
    pub title: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub scrollback: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::projects::Entity",
        from = "Column::ProjectId",
        to = "super::projects::Column::Id",
        on_delete = "Cascade"
    )]
    Projects,
}

impl Related<super::projects::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Projects.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
