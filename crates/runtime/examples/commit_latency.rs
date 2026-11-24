use std::sync::Arc;
use std::time::Instant;

use serde_json::json;
use tokio::sync::Barrier;
use tokio::task::JoinSet;
use vibevalley_runtime::agent::durable::{Error, Store};

const WRITES: usize = 60;

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    for writers in [1, 3, 6] {
        let store = Store::open(&dir.path().join(format!("{writers}.db"))).await?;
        let start = Arc::new(Barrier::new(writers));
        let wall = Instant::now();
        let mut workers = JoinSet::new();
        for worker in 0..writers {
            let store = store.clone();
            let start = start.clone();
            workers.spawn(async move {
                let key = format!("job-{worker}");
                start.wait().await;
                let mut samples = Vec::with_capacity(WRITES);
                for step in 0..WRITES {
                    let before = Instant::now();
                    let k = key.clone();
                    let (enter, leave) = store
                        .write_async(move |tx| {
                            Box::pin(async move {
                                let enter = Instant::now();
                                tx.put_document_async("repo", &k, "bench", &json!({ "step": step })).await?;
                                Ok((enter, Instant::now()))
                            })
                        })
                        .await?;
                    let ack = Instant::now();
                    samples.push([enter - before, leave - enter, ack - leave, ack - before]);
                }
                Ok::<_, Error>(samples)
            });
        }
        let mut samples = Vec::with_capacity(WRITES * writers);
        while let Some(res) = workers.join_next().await {
            samples.extend(res.expect("benchmark worker panicked")?);
        }
        let elapsed = wall.elapsed();
        let p95 = |index: usize| {
            let mut values: Vec<_> = samples.iter().map(|sample| sample[index].as_micros()).collect();
            values.sort_unstable();
            values[(95 * values.len()).div_ceil(100) - 1]
        };
        let stats = store.stats();
        assert_eq!(stats.committed_ops as usize, WRITES * writers);
        assert_eq!(stats.failed_ops, 0);
        println!(
            "{}",
            json!({
                "writers": writers, "writes": samples.len(), "batches": stats.batches, "wallMs": elapsed.as_millis(),
                "p95Us": {"beforeCallback": p95(0), "callback": p95(1), "afterCallback": p95(2), "total": p95(3)}
            })
        );
        store.close().await?;
    }
    Ok(())
}
