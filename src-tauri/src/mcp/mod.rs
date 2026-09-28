//! The `mynk-mcp` program: an MCP server for AI agents and a CLI for everything else.
//!
//! Nothing here imports `tauri`: this code runs in a second process that never builds an app.

pub mod cli;
pub mod doctor;
pub mod engine;
pub mod install;
pub mod library_cache;
pub mod output;
pub mod running;
pub mod semantic_link;
pub mod server;
pub mod time;

use std::process::ExitCode;
use std::sync::Arc;

use engine::Engine;

/// Names the log level of this process (`error`, `warn`, `info`, `debug`, `trace`, `off`).
pub const LOG_LEVEL_ENV: &str = "MYNK_MCP_LOG";

/// Diagnostics go to stderr only: stdout carries MCP framing and must stay pure.
struct StderrLogger {
    level: log::LevelFilter,
}

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("mynk-mcp {}: {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

/// The level [`LOG_LEVEL_ENV`] asks for; anything unreadable falls back to warnings.
fn log_level(raw: Option<&str>) -> log::LevelFilter {
    raw.and_then(|value| value.trim().parse().ok())
        .unwrap_or(log::LevelFilter::Warn)
}

/// Installs the stderr logger; a process that already has one keeps it.
fn install_logger() {
    let level = log_level(std::env::var(LOG_LEVEL_ENV).ok().as_deref());
    if log::set_boxed_logger(Box::new(StderrLogger { level })).is_ok() {
        log::set_max_level(level);
    }
}

/// With no arguments, speaks MCP on stdin/stdout; with a subcommand, runs the CLI.
pub fn run_binary() -> ExitCode {
    install_logger();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("mynk-mcp could not start: {error}");
            return ExitCode::from(1);
        }
    };

    if args.is_empty() {
        // Typed into a terminal by hand, the server would sit silent until Ctrl+C.
        if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            eprintln!(
                "mynk-mcp is waiting for an MCP client on stdin. For the command line, run: mynk-mcp --help"
            );
        }
        return runtime.block_on(async {
            let engine = match Engine::from_env() {
                Ok(engine) => Arc::new(engine),
                Err(error) => {
                    eprintln!("mynk-mcp could not start: {error}");
                    return ExitCode::from(1);
                }
            };
            match server::serve_stdio(engine).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("mynk-mcp stopped: {error}");
                    ExitCode::from(1)
                }
            }
        });
    }

    let code = runtime.block_on(async {
        let mut out = std::io::stdout();
        let mut err = std::io::stderr();
        cli::execute(&args, &mut out, &mut err).await
    });
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::Log;

    fn metadata(level: log::Level) -> log::Metadata<'static> {
        log::Metadata::builder().level(level).build()
    }

    #[test]
    fn diagnostics_are_off_below_the_level_the_environment_asks_for() {
        assert_eq!(log_level(None), log::LevelFilter::Warn);
        assert_eq!(log_level(Some("  ")), log::LevelFilter::Warn);
        assert_eq!(log_level(Some("shouting")), log::LevelFilter::Warn);
        assert_eq!(log_level(Some(" DEBUG ")), log::LevelFilter::Debug);
        assert_eq!(log_level(Some("off")), log::LevelFilter::Off);

        let default = StderrLogger {
            level: log_level(None),
        };
        assert!(default.enabled(&metadata(log::Level::Error)));
        assert!(default.enabled(&metadata(log::Level::Warn)));
        assert!(!default.enabled(&metadata(log::Level::Info)));
        assert!(!StderrLogger {
            level: log::LevelFilter::Off
        }
        .enabled(&metadata(log::Level::Error)));
    }
}
