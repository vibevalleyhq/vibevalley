use sea_orm::{DatabaseBackend, DatabaseConnection, DatabaseTransaction, DbErr, SqliteTransactionMode, TransactionOptions, TransactionTrait};
use serde::{Serialize, de::DeserializeOwned};

fn encode_word<T: Serialize>(value: &T) -> Result<String, String> {
    let value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    match value {
        serde_json::Value::String(word) => Ok(word),
        _ => Err("expected a wire enum word".into()),
    }
}

fn decode_word<T: DeserializeOwned>(s: String) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(s)).map_err(|e| e.to_string())
}

pub(crate) fn word<T: Serialize>(value: &T) -> sqlx::Result<String> {
    encode_word(value).map_err(|e| sqlx::Error::Encode(e.into()))
}

pub(crate) fn read_word<T: DeserializeOwned>(s: String) -> sqlx::Result<T> {
    decode_word(s).map_err(|e| sqlx::Error::Decode(e.into()))
}

pub(crate) fn json<T: Serialize>(value: &T) -> sqlx::Result<String> {
    serde_json::to_string(value).map_err(|e| sqlx::Error::Encode(e.into()))
}

pub(crate) fn read_json<T: DeserializeOwned>(s: String) -> sqlx::Result<T> {
    serde_json::from_str(&s).map_err(|e| sqlx::Error::Decode(e.into()))
}

pub(crate) fn optional<T>(result: sqlx::Result<T>) -> sqlx::Result<Option<T>> {
    match result {
        Ok(row) => Ok(Some(row)),
        Err(sqlx::Error::RowNotFound) => Ok(None),
        Err(error) => Err(error),
    }
}

#[allow(dead_code)] // Consumed across Wave 3-4 as domains migrate off sqlx.
pub(crate) fn db_word<T: Serialize>(value: &T) -> Result<String, DbErr> {
    encode_word(value).map_err(DbErr::Custom)
}

#[allow(dead_code)] // Consumed across Wave 3-4 as domains migrate off sqlx.
pub(crate) fn read_db_word<T: DeserializeOwned>(s: String) -> Result<T, DbErr> {
    decode_word(s).map_err(DbErr::Custom)
}

#[allow(dead_code)] // Consumed across Wave 3-4 as domains migrate off sqlx.
pub(crate) fn db_json<T: Serialize>(value: &T) -> Result<String, DbErr> {
    serde_json::to_string(value).map_err(|e| DbErr::Custom(e.to_string()))
}

#[allow(dead_code)] // Consumed across Wave 3-4 as domains migrate off sqlx.
pub(crate) fn read_db_json<T: DeserializeOwned>(s: String) -> Result<T, DbErr> {
    serde_json::from_str(&s).map_err(|e| DbErr::Custom(e.to_string()))
}

/// Opens a write transaction, using `BEGIN IMMEDIATE` on SQLite so writers serialize at begin.
pub(crate) async fn begin_write_tx(conn: &DatabaseConnection) -> Result<DatabaseTransaction, DbErr> {
    let opts = match conn.get_database_backend() {
        DatabaseBackend::Sqlite => TransactionOptions {
            sqlite_transaction_mode: Some(SqliteTransactionMode::Immediate),
            ..Default::default()
        },
        _ => TransactionOptions::default(),
    };
    conn.begin_with_options(opts).await
}

#[cfg(test)]
pub(crate) mod test_pg {
    use std::io::Write;
    use std::path::PathBuf;

    use sea_orm::{ConnectionTrait, Database};

    pub(crate) struct EphemeralPostgres {
        data_dir: PathBuf,
        pg_ctl: PathBuf,
        port: u16,
        _temp: tempfile::TempDir,
    }

    impl EphemeralPostgres {
        pub(crate) fn start() -> Option<Self> {
            let initdb = ["/opt/homebrew/bin/initdb", "/usr/local/bin/initdb"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;
            let pg_ctl = ["/opt/homebrew/bin/pg_ctl", "/usr/local/bin/pg_ctl"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())?;

            let temp = tempfile::tempdir().ok()?;
            let data_dir = temp.path().join("pgdata");
            let sock_dir = temp.path().join("sock");
            std::fs::create_dir_all(&sock_dir).ok()?;

            let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
            let port = listener.local_addr().ok()?.port();
            drop(listener);

            let init = std::process::Command::new(&initdb)
                .arg("-D")
                .arg(&data_dir)
                .args(["--username=postgres", "--auth=trust", "--encoding=UTF8", "--no-sync"])
                .output()
                .ok()?;
            assert!(init.status.success(), "initdb failed: {}", String::from_utf8_lossy(&init.stderr));

            let conf = format!(
                "\nlisten_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = '{}'\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n",
                sock_dir.display()
            );
            std::fs::OpenOptions::new()
                .append(true)
                .open(data_dir.join("postgresql.conf"))
                .unwrap()
                .write_all(conf.as_bytes())
                .unwrap();

            let log = temp.path().join("postgres.log");
            let start = std::process::Command::new(&pg_ctl)
                .arg("-D")
                .arg(&data_dir)
                .arg("-l")
                .arg(&log)
                .args(["-w", "start"])
                .output()
                .ok()?;
            assert!(
                start.status.success(),
                "pg_ctl start failed: {}\nlog:\n{}",
                String::from_utf8_lossy(&start.stderr),
                std::fs::read_to_string(&log).unwrap_or_default()
            );

            Some(Self {
                data_dir,
                pg_ctl,
                port,
                _temp: temp,
            })
        }

        pub(crate) fn create_database(&self, db_name: &str) {
            let admin_url = format!("postgres://postgres@127.0.0.1:{}/postgres", self.port);
            let name = db_name.to_owned();
            vibevalley_runtime::rt::block_on(async move {
                let db = Database::connect(&admin_url).await.expect("connect postgres admin db");
                db.execute_unprepared(&format!("CREATE DATABASE \"{name}\""))
                    .await
                    .expect("create test database");
                db.close().await.expect("close admin db");
            });
        }

        pub(crate) fn db_url(&self, db_name: &str) -> String {
            format!("postgres://postgres@127.0.0.1:{}/{}", self.port, db_name)
        }
    }

    impl Drop for EphemeralPostgres {
        fn drop(&mut self) {
            let _ = std::process::Command::new(&self.pg_ctl)
                .arg("-D")
                .arg(&self.data_dir)
                .args(["-m", "immediate", "-w", "stop"])
                .output();
        }
    }
}
