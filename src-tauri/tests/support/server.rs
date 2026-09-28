//! A tiny hand-rolled HTTP/1.1 server for the integration tests: raw control over the wire
//! (chunked bodies, dropped connections, bad Content-Length) and per-host/global in-flight counts.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub type Handler = Arc<dyn Fn(&ReqInfo) -> Reply + Send + Sync>;

/// One received request, as the test sees it.
#[derive(Debug, Clone, Default)]
pub struct ReqInfo {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl ReqInfo {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// A piece of a chunked response, optionally preceded by a pause.
#[derive(Clone)]
pub struct Chunk {
    pub delay: Duration,
    pub data: Vec<u8>,
}

impl Chunk {
    pub fn now(data: impl Into<Vec<u8>>) -> Self {
        Self {
            delay: Duration::ZERO,
            data: data.into(),
        }
    }

    pub fn after(millis: u64, data: impl Into<Vec<u8>>) -> Self {
        Self {
            delay: Duration::from_millis(millis),
            data: data.into(),
        }
    }
}

#[derive(Clone)]
pub enum Reply {
    /// Close the socket without writing anything.
    Close,
    Body {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        delay: Duration,
    },
    /// `Transfer-Encoding: chunked`. `abort` drops the connection before the terminator.
    Chunked {
        status: u16,
        headers: Vec<(String, String)>,
        chunks: Vec<Chunk>,
        abort: bool,
    },
}

impl Reply {
    pub fn status(status: u16) -> Self {
        Reply::Body {
            status,
            headers: Vec::new(),
            body: Vec::new(),
            delay: Duration::ZERO,
        }
    }

    pub fn text(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Reply::Body {
            status,
            headers: vec![("Content-Type".to_string(), content_type.to_string())],
            body: body.into(),
            delay: Duration::ZERO,
        }
    }

    pub fn html(body: impl Into<Vec<u8>>) -> Self {
        Reply::text(200, "text/html; charset=utf-8", body)
    }

    pub fn json(value: &serde_json::Value) -> Self {
        Reply::text(200, "application/json", value.to_string())
    }

    pub fn bytes(content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Reply::text(200, content_type, body)
    }

    pub fn redirect(status: u16, location: &str) -> Self {
        Reply::Body {
            status,
            headers: vec![("Location".to_string(), location.to_string())],
            body: Vec::new(),
            delay: Duration::ZERO,
        }
    }

    pub fn chunked(content_type: &str, chunks: Vec<Chunk>) -> Self {
        Reply::Chunked {
            status: 200,
            headers: vec![("Content-Type".to_string(), content_type.to_string())],
            chunks,
            abort: false,
        }
    }

    /// Chunked response that dies before the terminating chunk.
    pub fn chunked_abort(content_type: &str, chunks: Vec<Chunk>) -> Self {
        match Reply::chunked(content_type, chunks) {
            Reply::Chunked {
                status,
                headers,
                chunks,
                ..
            } => Reply::Chunked {
                status,
                headers,
                chunks,
                abort: true,
            },
            other => other,
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        let entry = (name.to_string(), value.to_string());
        match &mut self {
            Reply::Body { headers, .. } | Reply::Chunked { headers, .. } => headers.push(entry),
            Reply::Close => {}
        }
        self
    }

    pub fn with_delay(mut self, millis: u64) -> Self {
        if let Reply::Body { delay, .. } = &mut self {
            *delay = Duration::from_millis(millis);
        }
        self
    }
}

#[derive(Default)]
struct Inner {
    routes: Mutex<HashMap<String, Handler>>,
    log: Mutex<Vec<ReqInfo>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    per_host: Mutex<HashMap<String, (usize, usize)>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inner {
    fn enter(&self, host: &str) {
        let current = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(current, Ordering::SeqCst);
        let mut hosts = lock(&self.per_host);
        let entry = hosts.entry(host.to_string()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 = entry.1.max(entry.0);
    }

    fn leave(&self, host: &str) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        let mut hosts = lock(&self.per_host);
        if let Some(entry) = hosts.get_mut(host) {
            entry.0 = entry.0.saturating_sub(1);
        }
    }
}

pub struct TestServer {
    inner: Arc<Inner>,
    addrs: Vec<SocketAddr>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl TestServer {
    /// One listener on 127.0.0.1.
    pub async fn start() -> Self {
        Self::start_hosts(1).await
    }

    /// `count` listeners on 127.0.0.1 … 127.0.0.<count>, sharing routes and counters. Addresses
    /// that cannot be bound are skipped, so `host_count()` may be lower than `count`.
    pub async fn start_hosts(count: u8) -> Self {
        let inner = Arc::new(Inner::default());
        let mut addrs = Vec::new();
        let mut tasks = Vec::new();
        for index in 0..count {
            let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1 + index));
            let Ok(listener) = TcpListener::bind(SocketAddr::new(ip, 0)).await else {
                continue;
            };
            let Ok(addr) = listener.local_addr() else {
                continue;
            };
            addrs.push(addr);
            let inner = Arc::clone(&inner);
            tasks.push(tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let inner = Arc::clone(&inner);
                    tokio::spawn(async move {
                        let _ = serve(stream, inner).await;
                    });
                }
            }));
        }
        assert!(!addrs.is_empty(), "could not bind a loopback test server");
        Self {
            inner,
            addrs,
            tasks,
        }
    }

    pub fn host_count(&self) -> usize {
        self.addrs.len()
    }

    pub fn base(&self) -> String {
        format!("http://{}", self.addrs[0])
    }

    pub fn base_on(&self, index: usize) -> String {
        format!("http://{}", self.addrs[index % self.addrs.len()])
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base())
    }

    pub fn url_on(&self, index: usize, path: &str) -> String {
        format!("{}{path}", self.base_on(index))
    }

    pub fn route(
        &self,
        path: &str,
        handler: impl Fn(&ReqInfo) -> Reply + Send + Sync + 'static,
    ) -> &Self {
        lock(&self.inner.routes).insert(path.to_string(), Arc::new(handler));
        self
    }

    pub fn requests_to(&self, path: &str) -> Vec<ReqInfo> {
        lock(&self.inner.log)
            .iter()
            .filter(|r| r.path == path)
            .cloned()
            .collect()
    }

    pub fn hits(&self, path: &str) -> usize {
        lock(&self.inner.log)
            .iter()
            .filter(|r| r.path == path)
            .count()
    }

    pub fn total_hits(&self) -> usize {
        lock(&self.inner.log).len()
    }

    pub fn reset_log(&self) {
        lock(&self.inner.log).clear();
    }

    pub fn max_in_flight(&self) -> usize {
        self.inner.max_in_flight.load(Ordering::SeqCst)
    }

    pub fn max_in_flight_per_host(&self) -> usize {
        lock(&self.inner.per_host)
            .values()
            .map(|(_, max)| *max)
            .max()
            .unwrap_or(0)
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        410 => "Gone",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<ReqInfo>> {
    let mut buffer: Vec<u8> = Vec::with_capacity(1024);
    let mut scratch = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = find(&buffer, b"\r\n\r\n") {
            break pos;
        }
        let read = stream.read(&mut scratch).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&scratch[..read]);
        if buffer.len() > 1024 * 1024 {
            return Ok(None);
        }
    };

    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let Some(request_line) = lines.next() else {
        return Ok(None);
    };
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let path = match target.split_once('?') {
        Some((p, _)) => p.to_string(),
        None => target,
    };

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut scratch).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&scratch[..read]);
    }
    body.truncate(content_length);

    Ok(Some(ReqInfo {
        method,
        path,
        headers,
        body,
    }))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn serve(mut stream: TcpStream, inner: Arc<Inner>) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream).await? else {
        return Ok(());
    };
    let host = request
        .header("host")
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .to_string();

    inner.enter(&host);
    lock(&inner.log).push(request.clone());
    let handler = lock(&inner.routes).get(&request.path).cloned();
    let reply = match handler {
        Some(handler) => handler(&request),
        None => Reply::text(404, "text/plain", format!("no route for {}", request.path)),
    };
    let result = write_reply(&mut stream, &request, reply).await;
    inner.leave(&host);
    result
}

async fn write_reply(
    stream: &mut TcpStream,
    request: &ReqInfo,
    reply: Reply,
) -> std::io::Result<()> {
    let head_only = request.method == "HEAD";
    match reply {
        Reply::Close => {
            let _ = stream.shutdown().await;
        }
        Reply::Body {
            status,
            headers,
            body,
            delay,
        } => {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
            for (name, value) in &headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str(&format!("Content-Length: {}\r\n", body.len()));
            head.push_str("Connection: close\r\n\r\n");
            stream.write_all(head.as_bytes()).await?;
            if !head_only {
                stream.write_all(&body).await?;
            }
            stream.flush().await?;
            let _ = stream.shutdown().await;
        }
        Reply::Chunked {
            status,
            headers,
            chunks,
            abort,
        } => {
            let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
            for (name, value) in &headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
            stream.write_all(head.as_bytes()).await?;
            stream.flush().await?;
            if head_only {
                let _ = stream.shutdown().await;
                return Ok(());
            }
            for chunk in chunks {
                if !chunk.delay.is_zero() {
                    tokio::time::sleep(chunk.delay).await;
                }
                stream
                    .write_all(format!("{:x}\r\n", chunk.data.len()).as_bytes())
                    .await?;
                stream.write_all(&chunk.data).await?;
                stream.write_all(b"\r\n").await?;
                stream.flush().await?;
            }
            if !abort {
                stream.write_all(b"0\r\n\r\n").await?;
                stream.flush().await?;
            }
            let _ = stream.shutdown().await;
        }
    }
    Ok(())
}
