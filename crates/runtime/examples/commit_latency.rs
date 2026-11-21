use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use vibevalley_runtime::agent::durable::{Error, Result, Store};

const WRITES: usize = 60;

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    for writers in [1, 3, 6] {
        let store = Store::open(&dir.path().join(format!("{writers}.db")))?;
        let start = Arc::new(Barrier::new(writers));
        let wall = Instant::now();
        let samples = thread::scope(|scope| -> Result<Vec<[Duration; 4]>> {
            let mut workers = Vec::with_capacity(writers);
            for worker in 0..writers {
                let store = store.clone();
                let start = start.clone();
                workers.push(scope.spawn(move || {
                    let key = format!("job-{worker}");
                    start.wait();
                    let mut samples = Vec::with_capacity(WRITES);
                    for step in 0..WRITES {
                        let before = Instant::now();
                        let (enter, leave) = store.write(|tx| {
                            let enter = Instant::now();
                            tx.put_document("repo", &key, "bench", &json!({ "step": step }))?;
                            Ok((enter, Instant::now()))
                        })?;
                        let ack = Instant::now();
                        samples.push([enter - before, leave - enter, ack - leave, ack - before]);
                    }
                    Ok::<_, Error>(samples)
                }));
            }
            let mut samples = Vec::with_capacity(WRITES * writers);
            for worker in workers {
                samples.extend(worker.join().expect("benchmark worker panicked")?);
            }
            Ok(samples)
        })?;
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
        store.close()?;
    }
    Ok(())
}
