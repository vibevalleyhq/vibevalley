use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "session")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub controller: String,
    pub role: Option<String>,
    pub name: String,
    pub profile: Option<String>,
    pub runtime: String,
    #[sea_orm(column_type = "Text")]
    pub brief: String,
    pub cwd: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub policy: String,
    #[sea_orm(column_type = "Text")]
    pub bindings: String,
    pub hired_at: i64,
    pub runs: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub last_run: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub spent: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub tool_connections: Option<String>,
    pub machine: Option<String>,
    pub phase: String,
    pub departed: bool,
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub agent_session: Option<String>,
    pub base: Option<String>,
    pub run: Option<String>,
    pub helper_mode: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
