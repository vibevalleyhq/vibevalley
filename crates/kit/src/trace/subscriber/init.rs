/// Initializes the global `tracing_subscriber` stderr formatter using the first
/// non-empty environment variable in `env_vars`, falling back to `default_level`.
pub fn init_subscriber(env_vars: &[&str], default_level: &str) {
    let spec = env_vars
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| default_level.to_owned());
    let filter = tracing_subscriber::EnvFilter::try_new(&spec).unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_level));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
}
