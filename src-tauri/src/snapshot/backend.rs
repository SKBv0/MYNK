//! Snapshot backends. The browser resolves DNS and redirects outside the SSRF guard, so a run
//! only starts for a URL `vet_browser_target` vetted and pinned via `--host-resolver-rules`;
//! screenshots also pass the guarded `preflight` GET, DOM dumps do not.

use std::ffi::OsString;
use std::fmt;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::media::PNG_SIGNATURE;
use crate::error::truncate_chars;
use crate::state::next_temp_id;

/// Budget for a whole capture, pre-flight included; the effective value is
/// `AppState::snapshot_timeout`.
pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);
const WINDOW_SIZE: &str = "1200,800";
/// Page time, in milliseconds, the browser fast-forwards through before taking the screenshot.
const VIRTUAL_TIME_BUDGET_MS: u32 = 3000;
/// Smallest budget worth launching a browser for: below it the page's virtual time cannot even
/// run out, so the caller reports a timeout instead of starting a process.
pub const MIN_CAPTURE_BUDGET: Duration = Duration::from_millis(VIRTUAL_TIME_BUDGET_MS as u64);
/// Longest target URL handed to the browser; command lines have an operating-system limit.
const MAX_TARGET_URL_CHARS: usize = 8000;
/// Largest `--dump-dom` output accepted; anything bigger is a failure, never a truncated page.
pub const MAX_DOM_BYTES: usize = 4 * 1024 * 1024;
/// Most characters of a browser's stderr kept in a failure detail or the debug log.
const STDERR_DETAIL_CHARS: usize = 500;
/// Name prefix of a throwaway capture profile; `cleanup::sweep_capture_profiles` matches on it.
pub const CAPTURE_PROFILE_PREFIX: &str = "mynk-capture-";

/// Stable `SnapshotResult.reason` codes. The renderer only ever sees these; paths and
/// raw process output stay in the debug log.
pub mod reason {
    /// The pre-flight found a bot-protection / challenge page.
    pub const SECURITY_VERIFICATION_WALL: &str = "securityVerificationWall";
    /// No capture runtime at startup (no Chromium-based browser is installed).
    pub const RUNTIME_UNAVAILABLE: &str = "runtimeUnavailable";
    /// The browser could not be found or launched.
    pub const BROWSER_LAUNCH_FAILED: &str = "browserLaunchFailed";
    /// The pre-flight got an error status other than 401/403, or a transient 408/425/429.
    pub const HTTP_ERROR: &str = "httpError";
    /// The capture did not finish within `SNAPSHOT_TIMEOUT`.
    pub const CAPTURE_TIMEOUT: &str = "captureTimeout";
    /// The capture process finished without writing an image.
    pub const NO_IMAGE: &str = "noImage";
    /// Any other capture failure.
    pub const CAPTURE_FAILED: &str = "captureFailed";
    /// `cancel_snapshot_captures` stopped the capture.
    pub const CANCELLED: &str = "cancelled";
}

/// Why a capture failed: a stable `code` for the renderer and a `detail` that may contain
/// paths or process output, logged at debug level only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureFailure {
    pub code: &'static str,
    /// The failure means the capture runtime is unusable (`SnapshotKind::RuntimeMissing`).
    pub runtime_missing: bool,
    pub detail: String,
}

impl CaptureFailure {
    fn cancelled() -> Self {
        Self::new(reason::CANCELLED, "The capture was cancelled.")
    }

    pub fn is_cancelled(&self) -> bool {
        self.code == reason::CANCELLED
    }

    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            runtime_missing: false,
            detail: detail.into(),
        }
    }

    fn runtime(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            runtime_missing: true,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for CaptureFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

/// Maps a failed capture process's stderr to a failure code. A successful run also writes to
/// stderr ("N bytes written to file …"); only a non-zero exit gets here.
pub fn classify_capture_stderr(stderr: &str, browser: &Path) -> CaptureFailure {
    // The binary itself is unusable, so every later capture would fail the same way.
    if stderr.contains("error while loading shared libraries")
        || stderr.contains("is not a valid Win32 application")
        || stderr.contains("cannot open display")
    {
        return CaptureFailure::runtime(
            reason::BROWSER_LAUNCH_FAILED,
            format!(
                "The capture browser at {} could not be started: {}",
                browser.display(),
                truncate_chars(stderr, STDERR_DETAIL_CHARS)
            ),
        );
    }
    if stderr.contains("Failed to launch")
        || stderr.contains("ProcessSingleton")
        || stderr.contains("Running as root without --no-sandbox")
        || stderr.contains("Failed to move to new namespace")
        || stderr.contains("Failed to create a temporary")
    {
        return CaptureFailure::new(
            reason::BROWSER_LAUNCH_FAILED,
            truncate_chars(stderr, STDERR_DETAIL_CHARS),
        );
    }
    CaptureFailure::new(
        reason::CAPTURE_FAILED,
        truncate_chars(stderr, STDERR_DETAIL_CHARS),
    )
}

/// Kills the browser's whole process tree; `kill_on_drop` alone only terminates the launcher
/// process and leaves its renderer and GPU children running.
struct ProcessTree {
    pid: Option<u32>,
}

impl ProcessTree {
    fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }

    /// The process exited on its own: nothing to clean up (and its PID may be reused).
    fn disarm(&mut self) {
        self.pid = None;
    }

    async fn kill(&mut self) {
        let Some(pid) = self.pid.take() else { return };
        let Some(command) = kill_tree_command(pid) else {
            return;
        };
        match tokio::process::Command::from(command).status().await {
            Ok(status) if !status.success() => {
                log::debug!("snapshot: process tree kill for {pid} exited with {status}");
            }
            Ok(_) => {}
            Err(error) => log::debug!("snapshot: could not kill process tree {pid}: {error}"),
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        let Some(pid) = self.pid.take() else { return };
        if let Some(mut command) = kill_tree_command(pid) {
            // Drop can run on an async worker, so the killer is started and left to finish.
            if let Err(error) = command.spawn() {
                log::debug!("snapshot: could not kill process tree {pid}: {error}");
            }
        }
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn kill_tree_command(pid: u32) -> Option<std::process::Command> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Absolute path: a `taskkill.exe` earlier on PATH must not be run instead.
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut command =
            std::process::Command::new(system_root.join("System32").join("taskkill.exe"));
        command
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Some(command)
    }
    #[cfg(unix)]
    {
        let mut command = std::process::Command::new("kill");
        command
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Some(command)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        None
    }
}

/// A host name and the address the SSRF guard vetted for it. The browser is told to resolve the
/// host to exactly this address, so its own DNS lookup cannot land somewhere else (rebinding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPin {
    pub host: String,
    pub ip: IpAddr,
}

impl HostPin {
    /// Whether `host` is safe to embed in a `--host-resolver-rules` value; anything outside the
    /// plain DNS alphabet lets Chrome silently discard the pin.
    pub fn is_pinnable_host(host: &str) -> bool {
        !host.is_empty()
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    }

    /// Chrome's `--host-resolver-rules` value for this pin.
    pub fn resolver_rule(&self) -> String {
        let replacement = match self.ip {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        };
        format!("MAP {} {replacement}", self.host)
    }
}

/// A throwaway browser profile below the system temp directory; the user's own profile must
/// never be touched, and a shared one would serialize concurrent captures.
struct TempProfile {
    path: PathBuf,
    /// Cleared once the caller has taken the removal over ([`TempProfile::disarm`]).
    armed: bool,
}

impl TempProfile {
    fn create(root: &Path) -> Result<Self, CaptureFailure> {
        let path = root.join(format!("{CAPTURE_PROFILE_PREFIX}{}", next_temp_id()));
        let failed = |e: std::io::Error| {
            CaptureFailure::new(
                reason::CAPTURE_FAILED,
                format!(
                    "Could not create a capture profile at {}: {e}",
                    path.display()
                ),
            )
        };
        std::fs::create_dir_all(path.join("Default")).map_err(&failed)?;
        std::fs::create_dir_all(path.join("downloads")).map_err(&failed)?;
        let profile = Self {
            path: path.clone(),
            armed: true,
        };
        std::fs::write(
            path.join("Default").join("Preferences"),
            download_preferences(&path).to_string(),
        )
        .map_err(failed)?;
        Ok(profile)
    }

    fn path(&self) -> &Path {
        &self.path
    }

    /// Hands the removal to the caller, which can do it off the async worker.
    fn disarm(&mut self) -> PathBuf {
        self.armed = false;
        self.path.clone()
    }
}

impl Drop for TempProfile {
    fn drop(&mut self) {
        // Drop can run on an async worker, so it only gets one attempt; `remove_profile` retries.
        if self.armed {
            if let Err(error) = std::fs::remove_dir_all(&self.path) {
                log::debug!(
                    "snapshot: could not remove capture profile {}: {error}",
                    self.path.display()
                );
            }
        }
    }
}

/// Keeps a page-triggered download inside the throwaway profile instead of the user's Downloads
/// folder, and refuses the multi-file kind outright (`automatic_downloads: 2` = block).
fn download_preferences(profile: &Path) -> serde_json::Value {
    serde_json::json!({
        "download": {
            "default_directory": profile.join("downloads").to_string_lossy(),
            "prompt_for_download": false,
        },
        "profile": { "default_content_setting_values": { "automatic_downloads": 2 } },
    })
}

/// Removes a disarmed profile, retrying because a killed browser keeps its files locked for a
/// moment on Windows. Blocking work, so it runs off the async worker.
async fn remove_profile(path: PathBuf) {
    let removed = tokio::task::spawn_blocking(move || {
        for attempt in 0..5 {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) if attempt == 4 => return Err((path.clone(), error)),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        Ok(())
    })
    .await;
    match removed {
        Ok(Err((path, error))) => log::debug!(
            "snapshot: could not remove capture profile {}: {error}",
            path.display()
        ),
        Ok(Ok(())) => {}
        Err(error) => log::debug!("snapshot: the profile cleanup task failed: {error}"),
    }
}

/// What one browser run is asked to produce from the page it renders.
#[derive(Debug, Clone)]
enum Output {
    /// `--screenshot=<path>`: a PNG written to that path.
    Png(PathBuf),
    /// `--dump-dom`: the serialized DOM on stdout.
    Dom,
}

/// The browser command line for one run. The URL comes last and Chrome has no `--` separator,
/// so the caller must have vetted its scheme.
fn capture_args(
    profile: &Path,
    output: &Output,
    url: &Url,
    pin: Option<&HostPin>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--mute-audio",
        // A system proxy would resolve the host itself and void the `--host-resolver-rules` pin.
        "--no-proxy-server",
        // Unknown feature names are ignored, so this stays safe across browser versions.
        "--enable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,\
         PrivateNetworkAccessRespectPreflightResults",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-component-update",
        "--no-pings",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(OsString::from(format!("--window-size={WINDOW_SIZE}")));
    args.push(OsString::from(format!(
        "--virtual-time-budget={VIRTUAL_TIME_BUDGET_MS}"
    )));
    let mut profile_arg = OsString::from("--user-data-dir=");
    profile_arg.push(profile);
    args.push(profile_arg);
    if let Some(pin) = pin {
        args.push(OsString::from(format!(
            "--host-resolver-rules={}",
            pin.resolver_rule()
        )));
    }
    match output {
        Output::Png(path) => {
            let mut screenshot = OsString::from("--screenshot=");
            screenshot.push(path);
            args.push(screenshot);
        }
        Output::Dom => args.push(OsString::from("--dump-dom")),
    }
    args.push(OsString::from(url.as_str()));
    args
}

async fn starts_with_png_signature(path: &Path) -> bool {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return false;
    };
    let mut head = [0u8; PNG_SIGNATURE.len()];
    file.read_exact(&mut head).await.is_ok() && head == PNG_SIGNATURE
}

/// Headless capture through an installed Chromium-based browser, driven by command line only.
#[derive(Debug, Clone)]
pub struct ChromiumBackend {
    browser: PathBuf,
    /// Parent of the throwaway profiles; the system temp directory outside tests.
    profile_root: PathBuf,
}

impl ChromiumBackend {
    pub fn new(browser: PathBuf) -> Self {
        Self {
            browser,
            profile_root: std::env::temp_dir(),
        }
    }

    /// Test hook: keeps this backend's profiles in `root`, so leftovers can be counted exactly.
    #[must_use]
    pub fn with_profile_root(mut self, root: PathBuf) -> Self {
        self.profile_root = root;
        self
    }

    pub fn browser(&self) -> &Path {
        &self.browser
    }

    /// Renders `url` into a PNG at `output` within `budget`; `pin` forces the target host to an
    /// address the guard already accepted. Cancelling `cancel` stops the browser at once.
    pub async fn capture(
        &self,
        url: &Url,
        pin: Option<&HostPin>,
        output: &Path,
        budget: Duration,
        cancel: &CancellationToken,
    ) -> Result<(), CaptureFailure> {
        self.run_within(url, pin, Output::Png(output.to_path_buf()), budget, cancel)
            .await?;
        if !starts_with_png_signature(output).await {
            return Err(CaptureFailure::new(
                reason::NO_IMAGE,
                "The capture finished without writing a PNG.",
            ));
        }
        Ok(())
    }

    /// Renders `url` and returns the DOM the browser serialized, through the same throwaway
    /// profile, hardening flags, pin, budget and cancellation as a screenshot capture.
    pub async fn dump_dom(
        &self,
        url: &Url,
        pin: Option<&HostPin>,
        budget: Duration,
        cancel: &CancellationToken,
    ) -> Result<String, CaptureFailure> {
        let dom = self
            .run_within(url, pin, Output::Dom, budget, cancel)
            .await?;
        if dom.len() > MAX_DOM_BYTES {
            return Err(CaptureFailure::new(
                reason::CAPTURE_FAILED,
                format!("The rendered DOM is larger than {MAX_DOM_BYTES} bytes."),
            ));
        }
        if dom.is_empty() {
            return Err(CaptureFailure::new(
                reason::CAPTURE_FAILED,
                "The browser printed no DOM.",
            ));
        }
        Ok(String::from_utf8_lossy(&dom).into_owned())
    }

    /// One browser run inside a fresh profile; returns whatever it printed on stdout. The run is
    /// its own task, so dropping this future cancels it and still kills the tree and profile.
    async fn run_within(
        &self,
        url: &Url,
        pin: Option<&HostPin>,
        output: Output,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, CaptureFailure> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(CaptureFailure::new(
                reason::CAPTURE_FAILED,
                format!("Refusing to capture the \"{}\" scheme.", url.scheme()),
            ));
        }
        if url.as_str().chars().count() > MAX_TARGET_URL_CHARS {
            return Err(CaptureFailure::new(
                reason::CAPTURE_FAILED,
                format!("The URL is longer than {MAX_TARGET_URL_CHARS} characters."),
            ));
        }
        if cancel.is_cancelled() {
            return Err(CaptureFailure::cancelled());
        }
        let backend = self.clone();
        let url = url.clone();
        let pin = pin.cloned();
        let cancel = cancel.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let run = tokio::spawn(async move {
            let mut profile = TempProfile::create(&backend.profile_root)?;
            let result = backend
                .run_browser(
                    profile.path(),
                    &url,
                    pin.as_ref(),
                    &output,
                    timeout,
                    &cancel,
                )
                .await;
            remove_profile(profile.disarm()).await;
            result
        });
        run.await.unwrap_or_else(|error| {
            Err(CaptureFailure::new(
                reason::CAPTURE_FAILED,
                format!("The capture task failed: {error}"),
            ))
        })
    }

    /// One browser run against an existing profile; the caller owns the profile's lifetime.
    async fn run_browser(
        &self,
        profile: &Path,
        url: &Url,
        pin: Option<&HostPin>,
        output: &Output,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, CaptureFailure> {
        let wants_stdout = matches!(output, Output::Dom);
        let mut command = tokio::process::Command::new(&self.browser);
        command
            .args(capture_args(profile, output, url, pin))
            .stdin(Stdio::null())
            .stdout(if wants_stdout {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        // Own process group, so the whole tree can be signalled at once (`ProcessTree`).
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn().map_err(|e| {
            let detail = format!(
                "Could not start the capture browser at {}: {e}",
                self.browser.display()
            );
            // Only a missing binary means the runtime is gone; the rest may work on the next URL.
            if e.kind() == std::io::ErrorKind::NotFound {
                CaptureFailure::runtime(reason::BROWSER_LAUNCH_FAILED, detail)
            } else {
                CaptureFailure::new(reason::BROWSER_LAUNCH_FAILED, detail)
            }
        })?;

        // Drained while the browser runs, or a full pipe would block it.
        let reader = child.stdout.take().map(|out| {
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                // One byte past the cap is enough to tell a too-large DOM from a whole one.
                let limit = u64::try_from(MAX_DOM_BYTES)
                    .unwrap_or(u64::MAX)
                    .saturating_add(1);
                let _ = out.take(limit).read_to_end(&mut buffer).await;
                buffer
            })
        });

        let pid = child.id();
        let wait = child.wait_with_output();
        tokio::pin!(wait);
        // Declared after `wait`, so it is dropped (and kills the tree) before `wait` is.
        let mut tree = ProcessTree::new(pid);

        let finished = tokio::select! {
            // Biased: a browser that exited in the same poll as the deadline still wrote its PNG.
            biased;
            result = &mut wait => Ok(result),
            () = tokio::time::sleep(timeout) => Err(CaptureFailure::new(
                reason::CAPTURE_TIMEOUT,
                format!("Capture timed out after {} ms.", timeout.as_millis()),
            )),
            () = cancel.cancelled() => Err(CaptureFailure::cancelled()),
        };
        let result = match finished {
            Ok(result) => result,
            Err(failure) => {
                // The launcher is still alive here, so its children can still be found through it.
                tree.kill().await;
                if let Some(task) = reader {
                    task.abort();
                }
                return Err(failure);
            }
        };
        tree.disarm();
        let output_result = result.map_err(|e| {
            CaptureFailure::new(
                reason::CAPTURE_FAILED,
                format!("Capture process failed: {e}"),
            )
        })?;

        let stderr = String::from_utf8_lossy(&output_result.stderr);
        if !stderr.trim().is_empty() {
            log::debug!(
                "snapshot capture stderr: {}",
                truncate_chars(&stderr, STDERR_DETAIL_CHARS)
            );
        }
        if !output_result.status.success() {
            return Err(classify_capture_stderr(&stderr, &self.browser));
        }
        Ok(match reader {
            Some(task) => task.await.unwrap_or_default(),
            None => Vec::new(),
        })
    }
}

#[derive(Debug, Clone)]
pub enum Backend {
    Chromium(ChromiumBackend),
    /// No capture runtime available; the string explains why.
    Disabled(String),
}

/// Environment variable that lets the user (or a test) name the browser; it takes precedence
/// over discovery.
const BROWSER_ENV_OVERRIDES: [&str; 1] = ["CHROME_PATH"];

/// `(environment variable, path below it)` pairs for the usual Windows install locations.
#[cfg(windows)]
const WINDOWS_BROWSERS: [(&str, &str); 6] = [
    ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
    ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
    ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
    ("ProgramFiles", r"Microsoft\Edge\Application\msedge.exe"),
    (
        "ProgramFiles(x86)",
        r"Microsoft\Edge\Application\msedge.exe",
    ),
    ("LOCALAPPDATA", r"Microsoft\Edge\Application\msedge.exe"),
];

#[cfg(target_os = "macos")]
const MACOS_BROWSERS: [&str; 4] = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_BROWSERS: [&str; 5] = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
];

/// Every place a Chromium-based browser might live, in preference order. `env` is the
/// environment lookup (injected so this can be tested without touching the real machine).
pub fn browser_candidates(env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for key in BROWSER_ENV_OVERRIDES {
        if let Some(value) = env(key).filter(|v| !v.trim().is_empty()) {
            candidates.push(PathBuf::from(value));
        }
    }
    #[cfg(windows)]
    for (key, suffix) in WINDOWS_BROWSERS {
        if let Some(base) = env(key).filter(|v| !v.trim().is_empty()) {
            candidates.push(PathBuf::from(base).join(suffix));
        }
    }
    #[cfg(target_os = "macos")]
    candidates.extend(MACOS_BROWSERS.iter().map(PathBuf::from));
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(path) = env("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.extend(LINUX_BROWSERS.iter().map(|name| dir.join(name)));
        }
    }
    candidates
}

/// First candidate that `exists` accepts.
pub fn find_browser(
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    browser_candidates(env)
        .into_iter()
        .find(|candidate| exists(candidate))
}

fn detect_browser() -> Option<PathBuf> {
    find_browser(&|key| std::env::var(key).ok(), &|path| path.is_file())
}

impl Backend {
    /// Detects the best available backend (called once at startup).
    pub fn detect() -> Self {
        // Reported once here so each capture does not fail separately.
        let Some(browser) = detect_browser() else {
            return Backend::Disabled(
                "No Chrome, Edge or Chromium installation was found; live previews are \
                 unavailable."
                    .to_string(),
            );
        };
        log::info!("snapshot backend: chromium at {}", browser.display());
        Backend::Chromium(ChromiumBackend::new(browser))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    /// This machine's browser; `None` skips the test, unless CI sets `MYNK_REQUIRE_BROWSER`.
    fn installed_browser() -> Option<ChromiumBackend> {
        match Backend::detect() {
            Backend::Chromium(backend) => Some(backend),
            Backend::Disabled(reason) => {
                assert!(
                    std::env::var_os("MYNK_REQUIRE_BROWSER").is_none(),
                    "MYNK_REQUIRE_BROWSER is set, but there is no browser: {reason}"
                );
                eprintln!("skipping: no browser on this machine");
                None
            }
        }
    }

    /// A server that accepts and never answers, so a browser waits on it until it is stopped.
    async fn silent_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        (address, server)
    }

    /// Profile leftovers are counted per process, so tests that create one run one at a time.
    static PROFILE_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// Capture profiles this process created and has not cleaned up.
    fn leftover_profiles() -> Vec<PathBuf> {
        let prefix = format!("mynk-capture-{}-", std::process::id());
        let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix))
            })
            .collect()
    }

    #[test]
    fn an_explicit_override_wins_over_discovery() {
        let env = env_from(&[
            ("CHROME_PATH", "/opt/my-chrome"),
            ("ProgramFiles", r"C:\Program Files"),
            ("PATH", "/usr/bin"),
        ]);
        let found = find_browser(&|key| env.get(key).cloned(), &|_| true).expect("a browser");
        assert_eq!(found, PathBuf::from("/opt/my-chrome"));
    }

    #[test]
    fn discovery_skips_paths_that_do_not_exist() {
        let env = env_from(&[
            ("CHROME_PATH", "/nope/missing-chrome"),
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ("LOCALAPPDATA", r"C:\Users\t\AppData\Local"),
            ("PATH", "/usr/bin:/usr/local/bin"),
        ]);
        let candidates = browser_candidates(&|key| env.get(key).cloned());
        let last = candidates.last().cloned().expect("candidates");
        let found =
            find_browser(&|key| env.get(key).cloned(), &|path| path == last).expect("a browser");
        assert_eq!(found, last);
        assert!(
            candidates
                .first()
                .is_some_and(|first| first.as_path() == Path::new("/nope/missing-chrome")),
            "the override is tried first"
        );
    }

    #[test]
    fn nothing_installed_means_no_browser() {
        let env: HashMap<String, String> = HashMap::new();
        assert_eq!(find_browser(&|key| env.get(key).cloned(), &|_| false), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_prefers_chrome_then_edge() {
        let env = env_from(&[
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ("LOCALAPPDATA", r"C:\Users\t\AppData\Local"),
        ]);
        let candidates = browser_candidates(&|key| env.get(key).cloned());
        let names: Vec<String> = candidates
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names[0],
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        );
        assert!(names
            .iter()
            .any(|n| n == r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"));
        assert!(names
            .iter()
            .any(|n| n == r"C:\Users\t\AppData\Local\Google\Chrome\Application\chrome.exe"));
        let edge = names
            .iter()
            .position(|n| n.contains("msedge"))
            .expect("edge");
        let chrome = names
            .iter()
            .position(|n| n.contains("chrome.exe"))
            .expect("chrome");
        assert!(chrome < edge, "Chrome is the better tested of the two");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_expands_the_path_variable() {
        let env = env_from(&[("PATH", "/usr/bin:/usr/local/bin")]);
        let candidates = browser_candidates(&|key| env.get(key).cloned());
        assert!(candidates.contains(&PathBuf::from("/usr/bin/google-chrome")));
        assert!(candidates.contains(&PathBuf::from("/usr/local/bin/chromium")));
        assert!(candidates.contains(&PathBuf::from("/usr/local/bin/microsoft-edge")));
    }

    #[test]
    fn only_plain_dns_names_are_pinnable() {
        for host in [
            "example.com",
            "xn--bcher-kva.example",
            "a-b_c.d",
            "localhost",
        ] {
            assert!(HostPin::is_pinnable_host(host), "{host}");
        }
        for host in [
            "",
            "a,b.example.com",
            "a;b.example",
            "*.example.com",
            "a b.example",
        ] {
            assert!(!HostPin::is_pinnable_host(host), "{host:?}");
        }
    }

    #[test]
    fn a_pin_becomes_a_host_resolver_rule() {
        let v4 = HostPin {
            host: "example.com".to_string(),
            ip: "93.184.216.34".parse().expect("ip"),
        };
        assert_eq!(v4.resolver_rule(), "MAP example.com 93.184.216.34");

        let v6 = HostPin {
            host: "example.com".to_string(),
            ip: "2606:2800:220:1::1".parse().expect("ip"),
        };
        assert_eq!(
            v6.resolver_rule(),
            "MAP example.com [2606:2800:220:1::1]",
            "an IPv6 replacement must be bracketed"
        );
    }

    #[test]
    fn the_command_line_pins_the_host_and_ends_with_the_url() {
        let profile = Path::new("/tmp/mynk-capture-1-0");
        let output = Path::new("/tmp/out.png");
        let url = Url::parse("https://example.com/a?b=c").expect("url");
        let pin = HostPin {
            host: "example.com".to_string(),
            ip: "93.184.216.34".parse().expect("ip"),
        };

        let args: Vec<String> = capture_args(
            profile,
            &Output::Png(output.to_path_buf()),
            &url,
            Some(&pin),
        )
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
        for expected in [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--disable-background-networking",
            "--window-size=1200,800",
            "--virtual-time-budget=3000",
            "--user-data-dir=/tmp/mynk-capture-1-0",
            "--host-resolver-rules=MAP example.com 93.184.216.34",
            "--screenshot=/tmp/out.png",
            "--no-proxy-server",
            "--disable-sync",
            "--disable-default-apps",
            "--disable-component-update",
            "--no-pings",
            "--enable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,\
             PrivateNetworkAccessRespectPreflightResults",
        ] {
            assert!(
                args.iter().any(|arg| arg == expected),
                "{expected}: {args:?}"
            );
        }
        assert_eq!(args.last().map(String::as_str), Some(url.as_str()));
        assert!(
            !args.contains(&"--no-sandbox".to_string()),
            "the sandbox stays on"
        );

        assert!(
            !args.iter().any(|arg| arg.contains("MAP *")
                || arg.contains("--disable-javascript")
                || arg == "--disable-web-security"),
            "the page still has to load its assets and scripts: {args:?}"
        );

        let unpinned: Vec<String> =
            capture_args(profile, &Output::Png(output.to_path_buf()), &url, None)
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
        assert!(
            !unpinned
                .iter()
                .any(|arg| arg.starts_with("--host-resolver")),
            "no pin, no resolver rule: {unpinned:?}"
        );
        assert_eq!(unpinned.last().map(String::as_str), Some(url.as_str()));
    }

    #[test]
    fn a_dom_dump_differs_from_a_screenshot_only_in_what_it_produces() {
        let profile = Path::new("/tmp/mynk-capture-1-0");
        let url = Url::parse("https://example.com/a").expect("url");
        let pin = HostPin {
            host: "example.com".to_string(),
            ip: "93.184.216.34".parse().expect("ip"),
        };
        let args = |output| -> Vec<String> {
            capture_args(profile, &output, &url, Some(&pin))
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        };
        let png = args(Output::Png(PathBuf::from("/tmp/out.png")));
        let dom = args(Output::Dom);

        assert!(dom.contains(&"--dump-dom".to_string()), "{dom:?}");
        assert!(
            !dom.iter().any(|arg| arg.starts_with("--screenshot")),
            "a dump writes no image: {dom:?}"
        );
        let hardening: Vec<&String> = png
            .iter()
            .filter(|arg| !arg.starts_with("--screenshot"))
            .collect();
        for flag in &hardening {
            assert!(dom.contains(flag), "{flag} is missing from {dom:?}");
        }
        assert_eq!(dom.len(), hardening.len() + 1, "{dom:?}");
        assert_eq!(dom.last().map(String::as_str), Some(url.as_str()));
    }

    #[test]
    fn a_new_profile_sends_downloads_into_itself() {
        let dir = tempfile::tempdir().expect("profile root");
        let profile = TempProfile::create(dir.path()).expect("profile");
        let raw = std::fs::read_to_string(profile.path().join("Default").join("Preferences"))
            .expect("preferences");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
        assert_eq!(value["download"]["prompt_for_download"], false);
        assert_eq!(
            value["profile"]["default_content_setting_values"]["automatic_downloads"],
            2
        );
        let target = value["download"]["default_directory"]
            .as_str()
            .expect("a download directory");
        assert_eq!(Path::new(target), profile.path().join("downloads"));
        assert!(profile.path().join("downloads").is_dir());
    }

    #[tokio::test]
    async fn an_absurdly_long_url_is_refused_before_anything_is_spawned() {
        let root = tempfile::tempdir().expect("profile root");
        let backend = ChromiumBackend::new(PathBuf::from("/nonexistent/chrome"))
            .with_profile_root(root.path().to_path_buf());
        let url = Url::parse(&format!(
            "https://example.com/{}",
            "a".repeat(MAX_TARGET_URL_CHARS)
        ))
        .expect("url");
        let failure = backend
            .capture(
                &url,
                None,
                &root.path().join("out.png"),
                SNAPSHOT_TIMEOUT,
                &CancellationToken::new(),
            )
            .await
            .expect_err("a command line that long is refused");
        assert_eq!(failure.code, reason::CAPTURE_FAILED);
        assert!(!failure.runtime_missing);
        assert_eq!(
            std::fs::read_dir(root.path()).expect("root").count(),
            0,
            "no profile is created"
        );
    }

    /// A browser that exists but cannot be executed says nothing about the runtime as a whole.
    #[tokio::test]
    async fn only_a_missing_binary_reports_the_runtime_as_gone() {
        let root = tempfile::tempdir().expect("profile root");
        let not_a_program = root.path().join("not-a-program");
        std::fs::create_dir_all(&not_a_program).expect("directory");
        let backend =
            ChromiumBackend::new(not_a_program).with_profile_root(root.path().to_path_buf());
        let failure = backend
            .capture(
                &Url::parse("http://127.0.0.1:9/").expect("url"),
                None,
                &root.path().join("out.png"),
                SNAPSHOT_TIMEOUT,
                &CancellationToken::new(),
            )
            .await
            .expect_err("a directory cannot be executed");
        assert_eq!(failure.code, reason::BROWSER_LAUNCH_FAILED);
        assert!(
            !failure.runtime_missing,
            "one unusable path must not cancel every later capture: {failure}"
        );
    }

    #[test]
    fn stderr_is_reduced_to_a_stable_code() {
        let browser = Path::new(r"C:\Users\someone\chrome.exe");
        let unusable = classify_capture_stderr(
            "chrome: error while loading shared libraries: libnss3.so",
            browser,
        );
        assert_eq!(unusable.code, reason::BROWSER_LAUNCH_FAILED);
        assert!(unusable.runtime_missing);
        assert!(
            unusable.detail.contains("chrome.exe"),
            "detail keeps the path for the log"
        );

        for line in [
            "[0918/120000.000:ERROR:process_singleton_win.cc(1)] Failed to create a ProcessSingleton",
            "Failed to move to new namespace: PID namespaces supported",
            "[1:1:0918/120000.0:FATAL:zygote_host_impl_linux.cc(100)] Running as root without --no-sandbox is not supported",
        ] {
            let failure = classify_capture_stderr(line, browser);
            assert_eq!(failure.code, reason::BROWSER_LAUNCH_FAILED, "{line}");
            assert!(!failure.runtime_missing, "{line}");
        }

        let other = classify_capture_stderr(
            "[0918/120000.000:ERROR:headless_shell.cc(1)] Navigation to D:\\secret failed",
            browser,
        );
        assert_eq!(other.code, reason::CAPTURE_FAILED);

        for code in [unusable.code, other.code] {
            assert!(
                code.chars().all(|c| c.is_ascii_alphanumeric()),
                "codes are plain identifiers: {code}"
            );
        }
    }

    #[tokio::test]
    async fn a_capture_profile_is_removed_with_its_contents() {
        let _serial = PROFILE_TESTS.lock().await;
        let profile = TempProfile::create(&std::env::temp_dir()).expect("profile");
        let path = profile.path().to_path_buf();
        assert!(path.is_dir());
        std::fs::create_dir_all(path.join("Default")).expect("subdirectory");
        std::fs::write(path.join("Default").join("Preferences"), b"{}").expect("file");

        let second = TempProfile::create(&std::env::temp_dir()).expect("second profile");
        assert_ne!(second.path(), path, "concurrent captures get their own");

        drop(profile);
        assert!(!path.exists(), "the profile outlives no capture");
        let second_path = second.path().to_path_buf();
        drop(second);
        assert!(!second_path.exists());
    }

    #[tokio::test]
    async fn a_non_web_url_is_refused_before_anything_is_spawned() {
        let backend = ChromiumBackend::new(PathBuf::from("/nonexistent/chrome"));
        let output = std::env::temp_dir().join("mynk-capture-never.png");
        let failure = backend
            .capture(
                &Url::parse("file:///C:/Windows/win.ini").expect("url"),
                None,
                &output,
                SNAPSHOT_TIMEOUT,
                &CancellationToken::new(),
            )
            .await
            .expect_err("only http(s) may be captured");
        assert_eq!(failure.code, reason::CAPTURE_FAILED);
        assert!(!output.exists());
    }

    #[tokio::test]
    async fn an_already_cancelled_capture_starts_nothing() {
        let root = tempfile::tempdir().expect("profile root");
        let backend = ChromiumBackend::new(PathBuf::from("/nonexistent/chrome"))
            .with_profile_root(root.path().to_path_buf());
        let cancel = CancellationToken::new();
        cancel.cancel();
        let failure = backend
            .capture(
                &Url::parse("http://127.0.0.1:9/").expect("url"),
                None,
                &root.path().join("out.png"),
                SNAPSHOT_TIMEOUT,
                &cancel,
            )
            .await
            .expect_err("a cancelled capture does not run");
        assert!(failure.is_cancelled(), "{failure}");
        assert_eq!(
            std::fs::read_dir(root.path()).expect("root").count(),
            0,
            "no profile is created"
        );
    }

    #[tokio::test]
    async fn a_browser_that_cannot_start_leaves_no_profile_behind() {
        let _serial = PROFILE_TESTS.lock().await;
        let before = leftover_profiles();
        let backend = ChromiumBackend::new(PathBuf::from("/nonexistent/mynk-test-chrome"));
        let output = std::env::temp_dir().join("mynk-capture-missing-browser.png");
        let failure = backend
            .capture(
                &Url::parse("http://127.0.0.1:9/").expect("url"),
                None,
                &output,
                SNAPSHOT_TIMEOUT,
                &CancellationToken::new(),
            )
            .await
            .expect_err("a missing browser cannot capture");
        assert_eq!(failure.code, reason::BROWSER_LAUNCH_FAILED);
        assert!(failure.runtime_missing);
        assert!(!output.exists(), "no image is written for a failure");
        assert_eq!(leftover_profiles(), before, "the profile is cleaned up");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_timed_out_capture_kills_the_browser_and_removes_its_profile() {
        let Some(backend) = installed_browser() else {
            return;
        };
        let _serial = PROFILE_TESTS.lock().await;
        let before = leftover_profiles();
        let output =
            std::env::temp_dir().join(format!("mynk-capture-timeout-{}.png", std::process::id()));
        let failure = backend
            .capture(
                &Url::parse("http://127.0.0.1:9/").expect("url"),
                None,
                &output,
                Duration::from_millis(200),
                &CancellationToken::new(),
            )
            .await
            .expect_err("200 ms is not enough for any browser");
        assert_eq!(failure.code, reason::CAPTURE_TIMEOUT);
        assert_eq!(leftover_profiles(), before, "the profile is cleaned up");
        let _ = std::fs::remove_file(&output);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_capture_kills_the_browser_and_removes_its_profile() {
        let Some(backend) = installed_browser() else {
            return;
        };
        let root = tempfile::tempdir().expect("profile root");
        let backend = backend.with_profile_root(root.path().to_path_buf());
        let output = root.path().join("out.png");
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            trigger.cancel();
        });
        let (address, server) = silent_server().await;
        let started = std::time::Instant::now();
        let failure = backend
            .capture(
                &Url::parse(&format!("http://{address}/")).expect("url"),
                None,
                &output,
                SNAPSHOT_TIMEOUT,
                &cancel,
            )
            .await
            .expect_err("a cancelled capture fails");
        assert!(failure.is_cancelled(), "{failure}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        let left: Vec<_> = std::fs::read_dir(root.path())
            .expect("root")
            .flatten()
            .map(|entry| entry.path())
            .collect();
        assert!(left.is_empty(), "profile or image left behind: {left:?}");
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_capture_still_kills_the_browser_and_removes_its_profile() {
        let Some(backend) = installed_browser() else {
            return;
        };
        let root = tempfile::tempdir().expect("profile root");
        let backend = backend.with_profile_root(root.path().to_path_buf());
        let output = root.path().join("out.png");
        let (address, server) = silent_server().await;

        let abandoned = tokio::time::timeout(
            Duration::from_millis(300),
            backend.capture(
                &Url::parse(&format!("http://{address}/")).expect("url"),
                None,
                &output,
                SNAPSHOT_TIMEOUT,
                &CancellationToken::new(),
            ),
        )
        .await;
        assert!(abandoned.is_err(), "the capture was still running");

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let empty = || {
            std::fs::read_dir(root.path())
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(true)
        };
        while !empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(empty(), "the dropped capture left its profile behind");
        server.abort();
    }

    /// Spawns a shell whose grandchild holds stdout open; EOF proves the whole tree died,
    /// not just the direct child.
    fn spawn_tree_holding_stdout() -> std::process::Child {
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new("cmd");
            command
                .args(["/C", "ping -n 30 127.0.0.1 & exit 0"])
                .creation_flags(CREATE_NO_WINDOW);
            command
        };
        #[cfg(unix)]
        let mut command = {
            use std::os::unix::process::CommandExt;
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "sleep 30; exit 0"]).process_group(0);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a process tree")
    }

    fn stdout_closes_within(child: &mut std::process::Child, limit: Duration) -> bool {
        use std::io::Read;
        let mut stdout = child.stdout.take().expect("piped stdout");
        let (done, closed) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = stdout.read_to_end(&mut sink);
            let _ = done.send(());
        });
        closed.recv_timeout(limit).is_ok()
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn killing_the_tree_takes_the_grandchildren_too() {
        let mut child = spawn_tree_holding_stdout();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut tree = ProcessTree::new(Some(child.id()));
        tree.kill().await;
        assert!(
            stdout_closes_within(&mut child, Duration::from_secs(10)),
            "a grandchild survived the tree kill"
        );
        let _ = child.wait();
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn dropping_an_armed_tree_kills_it_and_a_disarmed_one_does_not() {
        let mut child = spawn_tree_holding_stdout();
        tokio::time::sleep(Duration::from_millis(500)).await;
        drop(ProcessTree::new(Some(child.id())));
        assert!(stdout_closes_within(&mut child, Duration::from_secs(10)));
        let _ = child.wait();

        let mut disarmed = ProcessTree::new(Some(u32::MAX));
        disarmed.disarm();
        assert_eq!(disarmed.pid, None);
    }

    #[test]
    fn detection_reports_why_it_is_disabled() {
        match Backend::detect() {
            Backend::Chromium(backend) => assert!(backend.browser().is_file()),
            Backend::Disabled(reason) => assert!(!reason.is_empty(), "{reason}"),
        }
    }
}
