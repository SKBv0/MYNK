//! Streaming chat completions: Ollama NDJSON and OpenRouter SSE.
//!
//! `drive` reads the body line by line, filters `<think>` blocks, and stops when `token` cancels.

use std::time::Duration;

use reqwest::Response;
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

/// Whole-stream limit (overrides the 120 s client timeout for streaming requests only).
pub const STREAM_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
/// Default maximum silence between two body chunks. Providers pass it to [`drive`]; tests
/// shorten it per provider instance (`with_stream_idle_timeout`) instead of through a global.
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Longest line (bytes, without its `\n`) a stream may send.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Visible characters delivered before the response counts as too long.
pub const MAX_OUTPUT_CHARS: usize = 400_000;
/// Hidden reasoning characters a stream may produce; not counted in `MAX_OUTPUT_CHARS`, so it
/// needs its own cap against a model that reasons endlessly.
pub const MAX_REASONING_CHARS: usize = 400_000;
/// How long to wait after the end marker for a usage report sent in a later chunk.
const USAGE_GRACE: Duration = Duration::from_secs(2);

/// Token usage reported by the provider (`ChatUsage` in ipcTypes.ts).
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Cost in USD when the provider reports it (OpenRouter `usage.cost`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// One parsed line of a provider stream.
#[derive(Debug, Default, PartialEq)]
pub struct StreamItem {
    pub delta: Option<String>,
    pub done: bool,
    pub usage: Option<Usage>,
    /// Characters of reasoning sent outside `delta` (Ollama `message.thinking`, OpenRouter
    /// `delta.reasoning`). Never shown, but charged to `MAX_REASONING_CHARS`.
    pub reasoning_chars: usize,
}

/// Receives visible text deltas; returning `false` stops the stream (receiver is gone).
pub type DeltaSink<'a> = dyn FnMut(&str) -> bool + Send + 'a;

/// Splits a byte stream into `\n`-terminated lines (UTF-8 is decoded per complete line, so
/// multi-byte characters split across chunks are never corrupted).
#[derive(Default)]
pub struct LineSplitter {
    buffer: Vec<u8>,
}

impl LineSplitter {
    pub fn push(&mut self, chunk: &[u8]) -> AppResult<Vec<String>> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
            // A complete line inside one large chunk is bounded too, not only a dangling tail.
            if pos > MAX_LINE_BYTES + 1 {
                return Err(oversized_line());
            }
            let line: Vec<u8> = self.buffer.drain(..=pos).collect();
            lines.push(
                String::from_utf8_lossy(&line)
                    .trim_end_matches(['\r', '\n'])
                    .to_string(),
            );
        }
        if self.buffer.len() > MAX_LINE_BYTES {
            return Err(oversized_line());
        }
        Ok(lines)
    }

    /// Remaining unterminated line at the end of the stream.
    pub fn finish(&mut self) -> Option<String> {
        let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buffer))
            .trim()
            .to_string();
        (!rest.is_empty()).then_some(rest)
    }
}

fn oversized_line() -> AppError {
    AppError::Parse("The response stream contained an oversized line.".to_string())
}

/// Incrementally removes `<think>…</think>` blocks, also when a tag is split across deltas.
#[derive(Default)]
pub struct ThinkFilter {
    inside: bool,
    pending: String,
    hidden_chars: usize,
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

/// Length of the longest suffix of `text` that is a proper prefix of `tag` (ASCII tag).
fn partial_tag_suffix(text: &str, tag: &str) -> usize {
    (1..tag.len())
        .rev()
        .find(|k| text.ends_with(&tag[..*k]))
        .unwrap_or(0)
}

impl ThinkFilter {
    /// Characters of reasoning dropped so far (tags excluded).
    pub fn hidden_chars(&self) -> usize {
        self.hidden_chars
    }

    pub fn push(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        let mut out = String::new();
        loop {
            if self.inside {
                if let Some(pos) = self.pending.find(THINK_CLOSE) {
                    self.hidden_chars += self.pending[..pos].chars().count();
                    self.pending.drain(..pos + THINK_CLOSE.len());
                    self.inside = false;
                    continue;
                }
                let emit_to = self.pending.len() - partial_tag_suffix(&self.pending, THINK_CLOSE);
                self.hidden_chars += self.pending[..emit_to].chars().count();
                self.pending.drain(..emit_to);
                return out;
            }
            let open = self.pending.find(THINK_OPEN);
            let close = self.pending.find(THINK_CLOSE);
            match (open, close) {
                // Some templates open the channel, so text before a stray close is reasoning.
                (_, Some(close)) if open.is_none_or(|open| close < open) => {
                    self.hidden_chars += self.pending[..close].chars().count();
                    self.pending.drain(..close + THINK_CLOSE.len());
                }
                (Some(open), _) => {
                    out.push_str(&self.pending[..open]);
                    self.pending.drain(..open + THINK_OPEN.len());
                    self.inside = true;
                }
                // No tag left: the arm above already caught every `close` that comes first.
                _ => {
                    // Hold back a suffix that may still grow into either tag.
                    let hold = partial_tag_suffix(&self.pending, THINK_OPEN)
                        .max(partial_tag_suffix(&self.pending, THINK_CLOSE));
                    let emit_to = self.pending.len() - hold;
                    out.push_str(&self.pending[..emit_to]);
                    self.pending.drain(..emit_to);
                    return out;
                }
            }
        }
    }

    /// Flushes held-back text at the end of the stream (an unterminated think block is dropped).
    pub fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.pending);
        if self.inside {
            String::new()
        } else {
            rest
        }
    }
}

fn as_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

pub fn parse_openai_usage(usage: &Value) -> Option<Usage> {
    let prompt = as_u64(usage.get("prompt_tokens"));
    let completion = as_u64(usage.get("completion_tokens"));
    if prompt.is_none() && completion.is_none() {
        return None;
    }
    Some(Usage {
        prompt_tokens: prompt.unwrap_or(0),
        completion_tokens: completion.unwrap_or(0),
        cost_usd: usage
            .get("cost")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c >= 0.0),
    })
}

/// Parses one Ollama `/api/chat` NDJSON line.
pub fn parse_ollama_line(line: &str) -> AppResult<Option<StreamItem>> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(line)
        .map_err(|e| AppError::Parse(format!("Ollama stream line was not valid JSON: {e}")))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(AppError::provider(
            format!(
                "Ollama error: {}",
                crate::error::truncate_chars(error, crate::error::MAX_ERROR_BODY_CHARS)
            ),
            None,
        ));
    }
    let done = value.get("done").and_then(Value::as_bool).unwrap_or(false);
    let usage = if done {
        let prompt = as_u64(value.get("prompt_eval_count"));
        let completion = as_u64(value.get("eval_count"));
        (prompt.is_some() || completion.is_some()).then(|| Usage {
            prompt_tokens: prompt.unwrap_or(0),
            completion_tokens: completion.unwrap_or(0),
            cost_usd: None,
        })
    } else {
        None
    };
    Ok(Some(StreamItem {
        delta: value
            .pointer("/message/content")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        done,
        usage,
        reasoning_chars: str_chars(value.pointer("/message/thinking")),
    }))
}

fn str_chars(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_str)
        .map_or(0, |text| text.chars().count())
}

/// Parses one OpenRouter SSE line (`data: {...}`, `data: [DONE]`, `: comment`).
pub fn parse_openrouter_line(line: &str, model: &str) -> AppResult<Option<StreamItem>> {
    let line = line.trim_end();
    if line.is_empty() || line.starts_with(':') {
        return Ok(None);
    }
    let Some(data) = line.strip_prefix("data:") else {
        // `event:` / `id:` / `retry:` fields carry nothing used here.
        return Ok(None);
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(Some(StreamItem {
            done: true,
            ..StreamItem::default()
        }));
    }
    let value: Value = serde_json::from_str(data)
        .map_err(|e| AppError::Parse(format!("OpenRouter stream chunk was not valid JSON: {e}")))?;
    if value.get("error").is_some() {
        let code = value
            .pointer("/error/code")
            .and_then(Value::as_u64)
            .and_then(|c| u16::try_from(c).ok())
            .unwrap_or(502);
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(|m| crate::error::truncate_chars(m, crate::error::MAX_ERROR_BODY_CHARS));
        return Err(super::openrouter::status_error(
            code,
            message.as_deref(),
            model,
        ));
    }
    // A non-null `finish_reason` is the end marker; some gateways never send `data: [DONE]`.
    let done = value
        .pointer("/choices/0/finish_reason")
        .is_some_and(|reason| !reason.is_null());
    Ok(Some(StreamItem {
        delta: value
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        done,
        usage: value.get("usage").and_then(parse_openai_usage),
        reasoning_chars: str_chars(value.pointer("/choices/0/delta/reasoning")),
    }))
}

struct Emitter<'s, 'a> {
    sink: &'s mut DeltaSink<'a>,
    filter: ThinkFilter,
    started: bool,
    emitted_chars: usize,
    /// Reasoning reported outside the text (`StreamItem::reasoning_chars`).
    side_reasoning_chars: usize,
}

impl<'s, 'a> Emitter<'s, 'a> {
    fn new(sink: &'s mut DeltaSink<'a>) -> Self {
        Self {
            sink,
            filter: ThinkFilter::default(),
            started: false,
            emitted_chars: 0,
            side_reasoning_chars: 0,
        }
    }

    /// Filters `<think>` blocks out of a raw delta and delivers the visible rest.
    fn push_delta(&mut self, delta: &str) -> AppResult<()> {
        let visible = self.filter.push(delta);
        self.emit(&visible)
    }

    /// Charges `side_chars` to the reasoning budget. `Ok(true)` ends the stream keeping any
    /// visible answer already delivered; with nothing visible it errors instead.
    fn reasoning_exhausted(&mut self, side_chars: usize, label: &str) -> AppResult<bool> {
        self.side_reasoning_chars = self.side_reasoning_chars.saturating_add(side_chars);
        let total = self
            .side_reasoning_chars
            .saturating_add(self.filter.hidden_chars());
        if total <= MAX_REASONING_CHARS {
            return Ok(false);
        }
        if self.started {
            log::warn!(
                "{label}: reasoning passed {MAX_REASONING_CHARS} characters; stopping the stream and keeping the visible answer"
            );
            return Ok(true);
        }
        Err(AppError::provider(
            format!(
                "{label} kept reasoning for more than {MAX_REASONING_CHARS} characters without starting an answer, so the response was stopped. Try again, or use a model without a thinking mode."
            ),
            None,
        ))
    }

    fn emit(&mut self, text: &str) -> AppResult<()> {
        // Reasoning models often start with blank lines once the think block is removed.
        let text = if self.started {
            text
        } else {
            text.trim_start()
        };
        if text.is_empty() {
            return Ok(());
        }
        self.started = true;
        self.emitted_chars += text.chars().count();
        if self.emitted_chars > MAX_OUTPUT_CHARS {
            return Err(AppError::Parse("The response is too long.".to_string()));
        }
        if !(self.sink)(text) {
            return Err(AppError::cancelled());
        }
        Ok(())
    }
}

fn describe_duration(duration: Duration) -> String {
    if duration.as_secs() >= 1 {
        format!("{} seconds", duration.as_secs())
    } else {
        format!("{} ms", duration.as_millis())
    }
}

/// Reads a streaming response until the provider's done marker, forwarding text deltas and
/// returning the last usage report. Cancellation drops the response.
pub async fn drive<P>(
    mut response: Response,
    token: &CancellationToken,
    label: &str,
    idle_timeout: Duration,
    mut parse: P,
    sink: &mut DeltaSink<'_>,
) -> AppResult<Option<Usage>>
where
    P: FnMut(&str) -> AppResult<Option<StreamItem>> + Send,
{
    let mut splitter = LineSplitter::default();
    let mut emitter = Emitter::new(sink);
    let mut usage = None;
    let mut done = false;
    // Set when the answer ends without usage: until then a late usage report is still awaited.
    let mut usage_deadline: Option<tokio::time::Instant> = None;

    while !done {
        let wait = usage_deadline.map_or(idle_timeout, |deadline| {
            deadline.saturating_duration_since(tokio::time::Instant::now())
        });
        let next = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(AppError::cancelled()),
            next = tokio::time::timeout(wait, response.chunk()) => next,
        };
        let chunk = match next {
            // After the answer a silent or broken stream only costs the usage report.
            Err(_) | Ok(Err(_)) if usage_deadline.is_some() => break,
            Err(_) => {
                return Err(AppError::Timeout(format!(
                    "{label} stopped sending data for {}.",
                    describe_duration(idle_timeout)
                )))
            }
            Ok(Err(error)) => {
                return Err(AppError::from_reqwest(
                    &format!("{label} stream failed"),
                    &error,
                ))
            }
            Ok(Ok(chunk)) => chunk,
        };
        let (lines, ended) = match chunk {
            Some(bytes) => (splitter.push(&bytes)?, false),
            None => (splitter.finish().into_iter().collect(), true),
        };
        for line in lines {
            let parsed = parse(&line);
            if usage_deadline.is_some() {
                // Past the end marker only usage matters; a second end marker or an error stops the wait.
                match parsed {
                    Ok(Some(item)) if item.usage.is_some() => {
                        usage = item.usage;
                        done = true;
                    }
                    Ok(Some(item)) => done = item.done,
                    Ok(None) => {}
                    Err(_) => done = true,
                }
                if done {
                    break;
                }
                continue;
            }
            let Some(item) = parsed? else { continue };
            if item.usage.is_some() {
                usage = item.usage;
            }
            if let Some(delta) = item.delta {
                emitter.push_delta(&delta)?;
            }
            if emitter.reasoning_exhausted(item.reasoning_chars, label)?
                || (item.done && usage.is_some())
            {
                done = true;
                break;
            }
            if item.done {
                usage_deadline = Some(tokio::time::Instant::now() + USAGE_GRACE);
            }
        }
        if ended && !done {
            // Some gateways just close the connection, so delivered text still counts as an answer.
            if usage_deadline.is_none() {
                if !emitter.started {
                    return Err(AppError::network(format!(
                        "The {label} response stream ended unexpectedly."
                    )));
                }
                log::info!(
                    "{label}: stream ended without a done marker; keeping the text received"
                );
            }
            done = true;
        }
    }

    let rest = emitter.filter.finish();
    emitter.emit(&rest)?;
    if !emitter.started {
        return Err(AppError::provider(
            format!("{label} returned an empty response."),
            None,
        ));
    }
    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_across_chunks_and_utf8_boundaries() {
        let mut splitter = LineSplitter::default();
        let text = "ça\nyı\r\nson".as_bytes();
        let first = splitter.push(&text[..1]).expect("push");
        assert!(first.is_empty());
        let rest = splitter.push(&text[1..]).expect("push");
        assert_eq!(rest, vec!["ça".to_string(), "yı".to_string()]);
        assert_eq!(splitter.finish().as_deref(), Some("son"));
        assert_eq!(splitter.finish(), None);
    }

    #[test]
    fn a_line_without_a_newline_is_bounded() {
        let mut splitter = LineSplitter::default();
        let piece = vec![b'a'; MAX_LINE_BYTES / 4];
        for _ in 0..4 {
            assert!(splitter.push(&piece).expect("within the limit").is_empty());
        }
        assert_eq!(
            splitter.push(b"\n").expect("terminated").len(),
            1,
            "a line of exactly MAX_LINE_BYTES is delivered"
        );

        let mut trickle = LineSplitter::default();
        for _ in 0..4 {
            trickle.push(&piece).expect("within the limit");
        }
        let error = trickle.push(b"a").expect_err("over the limit");
        assert_eq!(error.kind(), "parse");
        assert!(error.to_string().contains("oversized line"), "{error}");

        let mut burst = LineSplitter::default();
        assert!(burst.push(&vec![b'b'; MAX_LINE_BYTES + 1]).is_err());

        let mut whole = vec![b'c'; MAX_LINE_BYTES + 10];
        whole.push(b'\n');
        assert!(LineSplitter::default().push(&whole).is_err());
    }

    #[test]
    fn visible_output_is_capped_at_max_output_chars() {
        let mut delivered = Vec::new();
        let mut sink = |text: &str| {
            delivered.push(text.to_string());
            true
        };
        let sink: &mut DeltaSink<'_> = &mut sink;
        let mut emitter = Emitter::new(sink);

        let half = "ş".repeat(MAX_OUTPUT_CHARS / 2);
        emitter.push_delta(&half).expect("first half");
        emitter.push_delta(&half).expect("exactly at the limit");
        let error = emitter.push_delta("!").expect_err("one past the limit");
        assert_eq!(error.kind(), "parse");
        assert!(error.to_string().contains("too long"), "{error}");
        drop(emitter);

        let total: usize = delivered.iter().map(|d| d.chars().count()).sum();
        assert_eq!(
            total, MAX_OUTPUT_CHARS,
            "nothing past the cap reaches the sink"
        );
    }

    #[test]
    fn think_filter_counts_the_reasoning_it_drops() {
        let mut filter = ThinkFilter::default();
        let mut out = String::new();
        for part in ["a<thi", "nk>düş", "ün</th", "ink>b", "stray</think>c"] {
            out.push_str(&filter.push(part));
        }
        assert_eq!(out, "abc");
        // "düşün" (5) inside the block + "stray" (5) before the unpaired closing tag.
        assert_eq!(filter.hidden_chars(), 10);
    }

    #[test]
    fn endless_reasoning_without_an_answer_fails() {
        let mut delivered = Vec::new();
        let mut sink = |text: &str| {
            delivered.push(text.to_string());
            true
        };
        let sink: &mut DeltaSink<'_> = &mut sink;
        let mut emitter = Emitter::new(sink);

        emitter.push_delta("<think>").expect("open");
        let chunk = "x".repeat(MAX_REASONING_CHARS / 2);
        emitter.push_delta(&chunk).expect("thinking");
        assert!(!emitter.reasoning_exhausted(0, "Test").expect("under"));
        let error = emitter
            .reasoning_exhausted(MAX_REASONING_CHARS / 2 + 1, "Test")
            .expect_err("over the budget with nothing visible");
        assert_eq!(error.kind(), "provider");
        assert!(error.to_string().contains("reasoning"), "{error}");
        drop(emitter);
        assert!(delivered.is_empty());
    }

    #[test]
    fn endless_reasoning_after_an_answer_keeps_the_answer() {
        let mut delivered = Vec::new();
        let mut sink = |text: &str| {
            delivered.push(text.to_string());
            true
        };
        let sink: &mut DeltaSink<'_> = &mut sink;
        let mut emitter = Emitter::new(sink);

        emitter.push_delta("The answer.<think>").expect("answer");
        emitter
            .push_delta(&"y".repeat(MAX_REASONING_CHARS + 1))
            .expect("hidden text is not visible output");
        assert!(
            emitter.reasoning_exhausted(0, "Test").expect("kept"),
            "the stream ends instead of failing"
        );
        drop(emitter);
        assert_eq!(delivered.concat(), "The answer.");
    }

    #[test]
    fn think_filter_handles_split_tags() {
        let mut filter = ThinkFilter::default();
        let mut out = String::new();
        for part in ["Hi <thi", "nk>secret</th", "ink> there", " <", "b>"] {
            out.push_str(&filter.push(part));
        }
        out.push_str(&filter.finish());
        assert_eq!(out, "Hi  there <b>");

        let mut unterminated = ThinkFilter::default();
        assert_eq!(unterminated.push("a<think>never closed"), "a");
        assert_eq!(unterminated.finish(), "");
    }

    #[test]
    fn think_filter_drops_a_closing_tag_without_an_opener() {
        let mut filter = ThinkFilter::default();
        let mut out = String::new();
        for part in ["the plan</thi", "nk>the answer"] {
            out.push_str(&filter.push(part));
        }
        out.push_str(&filter.finish());
        assert_eq!(out, "the planthe answer");

        let mut mixed = ThinkFilter::default();
        assert_eq!(mixed.push("</think>a<think>more</think>b"), "ab");
    }

    #[test]
    fn parses_ollama_lines() {
        let delta =
            parse_ollama_line(r#"{"message":{"role":"assistant","content":"He"},"done":false}"#)
                .expect("parse")
                .expect("item");
        assert_eq!(delta.delta.as_deref(), Some("He"));
        assert!(!delta.done);

        let done = parse_ollama_line(
            r#"{"message":{"content":""},"done":true,"prompt_eval_count":12,"eval_count":34}"#,
        )
        .expect("parse")
        .expect("item");
        assert!(done.done);
        assert_eq!(done.delta, None);
        assert_eq!(
            done.usage,
            Some(Usage {
                prompt_tokens: 12,
                completion_tokens: 34,
                cost_usd: None
            })
        );

        let thinking =
            parse_ollama_line(r#"{"message":{"content":"","thinking":"düşün"},"done":false}"#)
                .expect("parse")
                .expect("item");
        assert_eq!(thinking.delta, None);
        assert_eq!(thinking.reasoning_chars, 5);

        assert!(parse_ollama_line("").expect("blank").is_none());
        let error = parse_ollama_line(r#"{"error":"model crashed"}"#).expect_err("error line");
        assert_eq!(error.kind(), "provider");
        assert!(parse_ollama_line("not json").is_err());
    }

    #[test]
    fn parses_openrouter_sse_lines() {
        assert!(parse_openrouter_line(": OPENROUTER PROCESSING", "m")
            .expect("comment")
            .is_none());
        assert!(parse_openrouter_line("event: message", "m")
            .expect("field")
            .is_none());
        let delta = parse_openrouter_line(
            r#"data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}"#,
            "m",
        )
        .expect("parse")
        .expect("item");
        assert_eq!(delta.delta.as_deref(), Some("Hel"));
        assert_eq!(delta.reasoning_chars, 0);

        let reasoning = parse_openrouter_line(
            r#"data: {"choices":[{"delta":{"content":"","reasoning":"plan it"},"finish_reason":null}]}"#,
            "m",
        )
        .expect("parse")
        .expect("item");
        assert_eq!(reasoning.reasoning_chars, 7);
        assert_eq!(reasoning.delta, None);

        let usage = parse_openrouter_line(
            r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.0012}}"#,
            "m",
        )
        .expect("parse")
        .expect("item");
        assert_eq!(
            usage.usage,
            Some(Usage {
                prompt_tokens: 10,
                completion_tokens: 5,
                cost_usd: Some(0.0012)
            })
        );

        assert!(!delta.done, "finish_reason: null is not an end marker");

        let done = parse_openrouter_line("data: [DONE]", "m")
            .expect("parse")
            .expect("item");
        assert!(done.done);

        let finished = parse_openrouter_line(
            r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            "m",
        )
        .expect("parse")
        .expect("item");
        assert!(finished.done);
        assert_eq!(finished.delta, None);

        let error =
            parse_openrouter_line(r#"data: {"error":{"code":429,"message":"slow down"}}"#, "m")
                .expect_err("error chunk");
        assert_eq!(error.status(), Some(429));
    }
}
