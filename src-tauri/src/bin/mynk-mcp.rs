//! Entry point: MCP server over stdio with no arguments, a CLI with a subcommand.

fn main() -> std::process::ExitCode {
    app_lib::mcp::run_binary()
}
