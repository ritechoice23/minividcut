//! Lets people use an assistant they already have installed (Claude Code,
//! Codex or OpenCode) to pick clips, instead of the small on-device model.
//!
//! MiniVidCut never reads, stores or asks for the assistant's credentials. It
//! launches the unmodified command line tool, which keeps its own sign-in, and
//! sends it transcript text only. Every call runs from an empty temporary
//! folder with tools disabled (or sandboxed) because transcripts are untrusted.

use crate::video::background;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

type Result<T> = std::result::Result<T, String>;

const NO_WINDOW: u32 = 0x0800_0000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(240);
const TEST_TIMEOUT: Duration = Duration::from_secs(90);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_PROMPT: usize = 2_000_000;
const MAX_CAPTURE: usize = 4_000_000;

/// Sentinel errors the interface turns into friendly messages.
pub(crate) const SIGNED_OUT: &str = "signed-out";
pub(crate) const CANCELED: &str = "canceled";

/// Sites the app may open on the user's behalf: sign-in and install pages.
const LINK_HOSTS: [&str; 6] = [
    "claude.com",
    "claude.ai",
    "anthropic.com",
    "openai.com",
    "chatgpt.com",
    "opencode.ai",
];

const SYSTEM: &str =
    "You select clips from transcripts and answer only with the requested structured output.";
const PING: &str =
    "Return exactly one clip: start 0, end 0, score 1, reason \"ok\". Respond with JSON only.";

/// Clips are given as transcript line numbers, never as timestamps, so a
/// model cannot invent a boundary that is not in the transcript.
const SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"required":["clips"],"properties":{"clips":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["start","end","score","reason"],"properties":{"start":{"type":"integer"},"end":{"type":"integer"},"score":{"type":"number"},"reason":{"type":"string"}}}}}}"#;

/// OpenCode cannot enforce a schema or disable tools by flag, so each call
/// runs as an agent that denies every permission. An unlocked OpenCode agent
/// writes files when a transcript tells it to.
const OPENCODE_AGENT: &str = "clipfinder";
const OPENCODE_CONFIG: &str = r#"{"$schema":"https://opencode.ai/config.json","agents":{"clipfinder":{"description":"Picks clips from transcripts","mode":"primary","system":"You select clips from transcripts and answer only with the requested JSON.","permissions":[{"action":"*","resource":"*","effect":"deny"}]}}}"#;

static CANCEL: AtomicBool = AtomicBool::new(false);
static ACTIVE_PID: AtomicU32 = AtomicU32::new(0);

/// One sign-in, test or search at a time.
#[derive(Default)]
pub struct AgentEngine(Mutex<()>);

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Opencode,
}

impl Provider {
    const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Opencode];

    fn program(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Opencode => "opencode",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
            Provider::Opencode => "OpenCode",
        }
    }

    fn login_args(self) -> &'static [&'static str] {
        match self {
            Provider::Claude | Provider::Opencode => &["auth", "login"],
            Provider::Codex => &["login"],
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Fast,
    Best,
}

// ---------------------------------------------------------------- processes

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stop {
    Finished,
    Canceled,
    TimedOut,
}

#[derive(Clone, Debug)]
struct Captured {
    success: bool,
    stopped: Stop,
    stdout: String,
    stderr: String,
}

type LineSink = Arc<dyn Fn(&str) + Send + Sync>;

fn base_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(NO_WINDOW);
    command
}

fn kill_tree(pid: u32) {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let _ = base_command(PathBuf::from(root).join("System32/taskkill.exe"))
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn pump(stream: impl Read + Send + 'static, sink: Option<LineSink>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut all = Vec::new();
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some(sink) = &sink {
                        sink(&String::from_utf8_lossy(&line));
                    }
                    if all.len() < MAX_CAPTURE {
                        all.extend_from_slice(&line);
                    }
                }
            }
        }
        String::from_utf8_lossy(&all).into_owned()
    })
}

/// Runs a command to completion with a time limit. Input goes to stdin from a
/// separate thread so a large transcript cannot deadlock against the output.
/// Only cancellable runs react to `cancel_agent_job`.
fn run(
    command: &mut Command,
    input: Option<Vec<u8>>,
    limit: Duration,
    sink: Option<LineSink>,
    cancellable: bool,
) -> Result<Captured> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the assistant: {error}"))?;
    if cancellable {
        ACTIVE_PID.store(child.id(), Ordering::SeqCst);
    }
    let writer = input.and_then(|data| {
        child.stdin.take().map(|mut stdin| {
            thread::spawn(move || {
                let _ = stdin.write_all(&data);
            })
        })
    });
    let stdout = child.stdout.take().map(|stream| pump(stream, sink.clone()));
    let stderr = child.stderr.take().map(|stream| pump(stream, sink));
    let deadline = Instant::now() + limit;
    let (stopped, status) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Stop::Finished, Some(status)),
            Ok(None) => {}
            Err(error) => {
                kill_tree(child.id());
                return Err(error.to_string());
            }
        }
        let stop = if cancellable && CANCEL.load(Ordering::SeqCst) {
            Some(Stop::Canceled)
        } else if Instant::now() >= deadline {
            Some(Stop::TimedOut)
        } else {
            None
        };
        if let Some(stop) = stop {
            kill_tree(child.id());
            let _ = child.wait();
            break (stop, None);
        }
        thread::sleep(Duration::from_millis(40));
    };
    if cancellable {
        ACTIVE_PID.store(0, Ordering::SeqCst);
    }
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let stdout = stdout
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();
    let stderr = stderr
        .map(|handle| handle.join().unwrap_or_default())
        .unwrap_or_default();
    Ok(Captured {
        success: status.is_some_and(|status| status.success()),
        stopped,
        stdout,
        stderr,
    })
}

/// Stops whichever sign-in or search is running.
#[tauri::command]
pub fn cancel_agent_job() {
    CANCEL.store(true, Ordering::SeqCst);
}

async fn exclusive<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    background(move || {
        let engine = app.state::<AgentEngine>();
        let _job = engine
            .0
            .try_lock()
            .map_err(|_| "Another assistant task is still running.".to_string())?;
        CANCEL.store(false, Ordering::SeqCst);
        work()
    })
    .await
}

// ---------------------------------------------------------------- detection

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    // A program started from the Start menu may not see folders that were
    // added to PATH after the user signed in, so check the usual homes too.
    for (variable, sub) in [
        ("USERPROFILE", ".local/bin"),
        ("USERPROFILE", ".opencode/bin"),
        ("APPDATA", "npm"),
        ("ProgramFiles", "nodejs"),
        ("LOCALAPPDATA", "Microsoft/WinGet/Links"),
    ] {
        if let Some(base) = std::env::var_os(variable) {
            dirs.push(PathBuf::from(base).join(sub));
        }
    }
    dirs
}

fn find_in(dirs: &[PathBuf], program: &str) -> Option<PathBuf> {
    dirs.iter().find_map(|dir| {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|extension| dir.join(format!("{program}.{extension}")))
            .find(|candidate| candidate.is_file())
    })
}

fn find_program(provider: Provider) -> Option<PathBuf> {
    find_in(&search_dirs(), provider.program())
}

#[derive(Serialize)]
pub struct AgentInfo {
    id: Provider,
    installed: bool,
    version: Option<String>,
}

fn probe(provider: Provider) -> AgentInfo {
    let Some(path) = find_program(provider) else {
        return AgentInfo {
            id: provider,
            installed: false,
            version: None,
        };
    };
    let version = run(
        base_command(&path).arg("--version"),
        None,
        PROBE_TIMEOUT,
        None,
        false,
    )
    .ok()
    .filter(|out| out.success)
    .and_then(|out| {
        strip_ansi(&format!("{}\n{}", out.stdout, out.stderr))
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| line.chars().take(60).collect())
    });
    AgentInfo {
        id: provider,
        installed: true,
        version,
    }
}

#[tauri::command]
pub async fn detect_agents() -> Result<Vec<AgentInfo>> {
    background(|| {
        let handles: Vec<_> = Provider::ALL
            .into_iter()
            .map(|provider| thread::spawn(move || probe(provider)))
            .collect();
        Ok(handles
            .into_iter()
            .zip(Provider::ALL)
            .map(|(handle, provider)| {
                handle.join().unwrap_or(AgentInfo {
                    id: provider,
                    installed: false,
                    version: None,
                })
            })
            .collect())
    })
    .await
}

#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Signin {
    Unknown,
    Out,
    In,
}

/// A quick local check. It can say "signed out" with certainty, but "signed
/// in" only means credentials exist: an expired login still reports as signed
/// in, so only a real test call proves an assistant is ready.
fn classify_signin(provider: Provider, out: &Captured) -> Signin {
    if out.stopped != Stop::Finished {
        return Signin::Unknown;
    }
    match provider {
        Provider::Claude => serde_json::from_str::<Value>(out.stdout.trim())
            .ok()
            .and_then(|value| value.get("loggedIn").and_then(Value::as_bool))
            .map_or(
                Signin::Unknown,
                |on| if on { Signin::In } else { Signin::Out },
            ),
        Provider::Codex => {
            if out.success {
                Signin::In
            } else {
                Signin::Out
            }
        }
        Provider::Opencode => {
            if !out.success {
                return Signin::Unknown;
            }
            let connected = strip_ansi(&out.stdout).lines().any(|line| {
                let line = line.to_lowercase();
                line.contains("stored") || line.contains("environment")
            });
            if connected {
                Signin::In
            } else {
                Signin::Out
            }
        }
    }
}

#[tauri::command]
pub async fn agent_signin_state(provider: Provider) -> Result<Signin> {
    background(move || {
        let Some(path) = find_program(provider) else {
            return Ok(Signin::Unknown);
        };
        let args: &[&str] = match provider {
            Provider::Claude => &["auth", "status", "--json"],
            Provider::Codex => &["login", "status"],
            Provider::Opencode => &["auth", "list"],
        };
        Ok(run(
            base_command(&path).args(args),
            None,
            PROBE_TIMEOUT,
            None,
            false,
        )
        .map_or(Signin::Unknown, |out| classify_signin(provider, &out)))
    })
    .await
}

#[tauri::command]
pub async fn opencode_models() -> Result<Vec<String>> {
    background(|| {
        let path = find_program(Provider::Opencode).ok_or("OpenCode isn’t installed.")?;
        let out = run(
            base_command(&path).arg("models"),
            None,
            Duration::from_secs(30),
            None,
            false,
        )?;
        Ok(strip_ansi(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| line.contains('/') && !line.contains(char::is_whitespace))
            .take(2000)
            .map(str::to_owned)
            .collect())
    })
    .await
}

// ------------------------------------------------------------------ sign-in

/// Pulls the first web address out of a line of tool output.
fn find_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | '<' | '>'))
        .collect();
    let url = url.trim_end_matches(['.', ',', ')', ';']);
    (url.len() > "https://".len()).then(|| url.to_owned())
}

/// Only https links to the assistants' own sites may be opened.
fn allowed_url(url: &str) -> bool {
    if url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains(['@', '\\']) {
        return false;
    }
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    if !port.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let host = host.to_ascii_lowercase();
    LINK_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

#[tauri::command]
pub fn open_agent_link(app: AppHandle, url: String) -> Result<()> {
    if !allowed_url(&url) {
        return Err("That link can’t be opened from here.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// The command line that opens a tool in its own visible console window. It
/// returns at once, so the interface decides when the user is done.
fn console_line(title: &str, path: &Path, args: &[&str]) -> String {
    format!(
        "/d /c start \"{title} sign-in\" \"{}\" {}",
        path.display(),
        args.join(" ")
    )
}

/// Runs the tool's own sign-in. The tool opens the browser, waits for the
/// user to approve there and exits. With `terminal` the real tool opens in a
/// visible console instead, for tools that need one to sign in; that returns
/// at once and the interface asks the user when they are done.
fn login(provider: Provider, terminal: bool, urls: &Channel<String>) -> Result<()> {
    let path =
        find_program(provider).ok_or_else(|| format!("{} isn’t installed.", provider.name()))?;
    if terminal {
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut command = base_command(shell);
        command.raw_arg(console_line(provider.name(), &path, provider.login_args()));
        let out = run(&mut command, None, PROBE_TIMEOUT, None, false)?;
        return if out.success {
            Ok(())
        } else {
            Err("Couldn’t open the sign-in window.".into())
        };
    }
    let sent = Arc::new(AtomicBool::new(false));
    let channel = urls.clone();
    let sink: LineSink = Arc::new(move |line| {
        if let Some(url) = find_url(line).filter(|url| allowed_url(url)) {
            if !sent.swap(true, Ordering::SeqCst) {
                let _ = channel.send(url);
            }
        }
    });
    let mut command = base_command(&path);
    command
        .args(provider.login_args())
        .current_dir(std::env::temp_dir());
    let out = run(&mut command, None, LOGIN_TIMEOUT, Some(sink), true)?;
    match out.stopped {
        Stop::Canceled => Err(CANCELED.into()),
        Stop::TimedOut => Err("Sign-in timed out. Try again.".into()),
        Stop::Finished if out.success => Ok(()),
        Stop::Finished => Err("Sign-in didn’t finish. Try again.".into()),
    }
}

#[tauri::command]
pub async fn agent_login(
    app: AppHandle,
    provider: Provider,
    terminal: bool,
    urls: Channel<String>,
) -> Result<()> {
    exclusive(app, move || login(provider, terminal, &urls)).await
}

// ------------------------------------------------------------------ search

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    SignedOut,
    Canceled,
    Failed(String),
}

impl Failure {
    fn message(self) -> String {
        match self {
            Failure::SignedOut => SIGNED_OUT.into(),
            Failure::Canceled => CANCELED.into(),
            Failure::Failed(text) => text,
        }
    }
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
        } else if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

/// Error output without the noise assistants print about unrelated plugins.
fn relevant(text: &str) -> String {
    strip_ansi(text)
        .lines()
        .filter(|line| !line.contains("rmcp::") && !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn looks_signed_out(text: &str) -> bool {
    let text = relevant(text).to_lowercase();
    [
        "not logged in",
        "please log in",
        "log in again",
        "/login",
        "unauthorized",
        "401",
        "invalid api key",
        "authentication",
        "sign in",
        "no model is available",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn short(text: &str) -> String {
    let line = relevant(text)
        .lines()
        .last()
        .unwrap_or("")
        .trim()
        .to_owned();
    line.chars().take(200).collect()
}

fn finished(out: &Captured) -> std::result::Result<(), Failure> {
    match out.stopped {
        Stop::Canceled => Err(Failure::Canceled),
        Stop::TimedOut => Err(Failure::Failed(
            "The assistant took too long to answer. Try again.".into(),
        )),
        Stop::Finished => Ok(()),
    }
}

/// Finds the JSON object in a model's reply, which may be wrapped in a code
/// fence or a sentence.
fn extract_json(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let slice = text.get(start..=end)?;
    serde_json::from_str::<Value>(slice)
        .ok()
        .map(|_| slice.to_owned())
}

fn claude_outcome(out: &Captured) -> std::result::Result<String, Failure> {
    finished(out)?;
    let value: Value = serde_json::from_str(out.stdout.trim()).map_err(|_| {
        Failure::Failed(match short(&out.stderr) {
            text if text.is_empty() => "Claude Code stopped unexpectedly.".into(),
            text => text,
        })
    })?;
    if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        let result = value.get("result").and_then(Value::as_str).unwrap_or("");
        let status = value.get("api_error_status").and_then(Value::as_u64);
        return Err(if status == Some(401) || looks_signed_out(result) {
            Failure::SignedOut
        } else {
            Failure::Failed(result.chars().take(200).collect())
        });
    }
    match value
        .get("structured_output")
        .filter(|answer| !answer.is_null())
    {
        Some(answer) => Ok(answer.to_string()),
        None => Err(Failure::Failed(
            "Claude Code didn’t return a usable answer.".into(),
        )),
    }
}

fn codex_outcome(answer: Option<String>, out: &Captured) -> std::result::Result<String, Failure> {
    finished(out)?;
    if let Some(answer) = answer.filter(|text| out.success && !text.trim().is_empty()) {
        return Ok(answer.trim().to_owned());
    }
    Err(if looks_signed_out(&out.stderr) {
        Failure::SignedOut
    } else {
        Failure::Failed(match short(&out.stderr) {
            text if text.is_empty() => "Codex didn’t return an answer.".into(),
            text => text,
        })
    })
}

fn opencode_outcome(out: &Captured) -> std::result::Result<String, Failure> {
    finished(out)?;
    let mut text = String::new();
    let mut error = None;
    for line in out.stdout.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(part) = event.pointer("/part/text").and_then(Value::as_str) {
                    text.push_str(part);
                }
            }
            Some("error") => {
                error = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            _ => {}
        }
    }
    if let Some(json) = extract_json(&text) {
        return Ok(json);
    }
    let detail = error.unwrap_or_else(|| short(&out.stderr));
    Err(if looks_signed_out(&detail) {
        Failure::SignedOut
    } else if detail.is_empty() {
        Failure::Failed("OpenCode didn’t return a usable answer.".into())
    } else {
        Failure::Failed(detail.chars().take(200).collect())
    })
}

fn ask(
    provider: Provider,
    quality: Quality,
    model: Option<&str>,
    prompt: &str,
    limit: Duration,
) -> std::result::Result<String, Failure> {
    let path = find_program(provider)
        .ok_or_else(|| Failure::Failed(format!("{} isn’t installed.", provider.name())))?;
    let folder = tempfile::tempdir().map_err(|error| Failure::Failed(error.to_string()))?;
    let dir = folder.path();
    let failed = |error: std::io::Error| Failure::Failed(error.to_string());
    let input = Some(prompt.as_bytes().to_vec());
    let mut command = base_command(&path);
    // Some tools trust a PWD inherited from the shell that started MiniVidCut over
    // the real working directory, and would then read another folder's settings.
    command
        .current_dir(dir)
        .env("PWD", dir)
        .env_remove("OLDPWD");
    match provider {
        Provider::Claude => {
            let mcp = dir.join("mcp.json");
            fs::write(&mcp, r#"{"mcpServers":{}}"#).map_err(failed)?;
            // No tools, no user plugins or servers, no saved session: a lean
            // call costs a fraction of one that loads the user's setup.
            command
                .args([
                    "-p",
                    "--output-format",
                    "json",
                    "--json-schema",
                    SCHEMA,
                    "--tools",
                    "",
                    "--no-session-persistence",
                    "--disable-slash-commands",
                    "--setting-sources",
                    "project",
                    "--strict-mcp-config",
                    "--mcp-config",
                ])
                .arg(&mcp)
                .args(["--system-prompt", SYSTEM, "--model"])
                .arg(model.unwrap_or(match quality {
                    Quality::Fast => "haiku",
                    Quality::Best => "sonnet",
                }));
            let out = run(&mut command, input, limit, None, true).map_err(Failure::Failed)?;
            claude_outcome(&out)
        }
        Provider::Codex => {
            let schema = dir.join("schema.json");
            let answer = dir.join("answer.txt");
            // Written without a byte-order mark, which Codex rejects.
            fs::write(&schema, SCHEMA).map_err(failed)?;
            command
                .args([
                    "exec",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "-s",
                    "read-only",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "-c",
                ])
                .arg(format!(
                    "model_reasoning_effort={}",
                    match quality {
                        Quality::Fast => "low",
                        Quality::Best => "medium",
                    }
                ));
            if let Some(model) = model {
                command.args(["-m", model]);
            }
            command
                .arg("--output-schema")
                .arg(&schema)
                .arg("-o")
                .arg(&answer)
                .arg("-");
            let out = run(&mut command, input, limit, None, true).map_err(Failure::Failed)?;
            codex_outcome(fs::read_to_string(&answer).ok(), &out)
        }
        Provider::Opencode => {
            fs::write(dir.join("opencode.json"), OPENCODE_CONFIG).map_err(failed)?;
            // A private server loads this folder's config straight away. The
            // shared background service loads a new folder lazily, so its first
            // request would not see the locked agent.
            command.args([
                "run",
                "--standalone",
                "--format",
                "json",
                "--agent",
                OPENCODE_AGENT,
            ]);
            if let Some(model) = model {
                command.args(["--model", model]);
            }
            let out = run(&mut command, input, limit, None, true).map_err(Failure::Failed)?;
            opencode_outcome(&out)
        }
    }
}

/// Model names go on a command line, so they may not look like options.
fn clean_model(model: Option<String>) -> Result<Option<String>> {
    let Some(model) = model
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
    else {
        return Ok(None);
    };
    let valid = model.len() <= 120
        && !model.starts_with('-')
        && model.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '#' | '@' | '+' | '-')
        });
    if valid {
        Ok(Some(model))
    } else {
        Err("Choose a valid model name.".into())
    }
}

#[tauri::command]
pub async fn run_agent_search(
    app: AppHandle,
    provider: Provider,
    quality: Quality,
    model: Option<String>,
    prompt: String,
) -> Result<String> {
    if prompt.trim().is_empty() || prompt.len() > MAX_PROMPT {
        return Err("The transcript is empty or too long to send.".into());
    }
    let model = clean_model(model)?;
    exclusive(app, move || {
        ask(provider, quality, model.as_deref(), &prompt, SEARCH_TIMEOUT).map_err(Failure::message)
    })
    .await
}

#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ready,
    SignedOut,
    Failed,
}

#[derive(Serialize)]
pub struct TestResult {
    health: Health,
    message: Option<String>,
}

fn ping_result(result: std::result::Result<String, Failure>) -> TestResult {
    let (health, message) = match result {
        Ok(raw) if serde_json::from_str::<Value>(&raw).is_ok_and(|v| v.get("clips").is_some()) => {
            (Health::Ready, None)
        }
        Ok(_) => (
            Health::Failed,
            Some("The assistant answered in an unexpected format.".into()),
        ),
        Err(Failure::SignedOut) => (Health::SignedOut, None),
        Err(Failure::Canceled) => (Health::Failed, Some("Canceled.".into())),
        Err(Failure::Failed(text)) => (Health::Failed, Some(text)),
    };
    TestResult { health, message }
}

/// A tiny real call through the whole path. Status commands cannot show
/// whether an assistant will really answer, this can.
#[tauri::command]
pub async fn test_agent(
    app: AppHandle,
    provider: Provider,
    quality: Quality,
    model: Option<String>,
) -> Result<TestResult> {
    let model = clean_model(model)?;
    exclusive(app, move || {
        Ok(ping_result(ask(
            provider,
            quality,
            model.as_deref(),
            PING,
            TEST_TIMEOUT,
        )))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done(success: bool, stdout: &str, stderr: &str) -> Captured {
        Captured {
            success,
            stopped: Stop::Finished,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn claude_expired_login_is_reported_as_signed_out() {
        let out = done(
            false,
            r#"{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate. API Error: 401 {\"error\":{\"message\":\"OAuth access token is invalid.\"}}"}"#,
            "",
        );
        assert_eq!(claude_outcome(&out), Err(Failure::SignedOut));
    }

    #[test]
    fn claude_answer_comes_from_structured_output_not_result() {
        let out = done(
            true,
            r#"{"type":"result","is_error":false,"result":"","structured_output":{"clips":[{"start":2,"end":4,"score":8,"reason":"Funny"}]}}"#,
            "",
        );
        let answer: Value = serde_json::from_str(&claude_outcome(&out).unwrap()).unwrap();
        assert_eq!(answer["clips"][0]["end"], 4);
        let missing = done(
            true,
            r#"{"type":"result","is_error":false,"result":"hello"}"#,
            "",
        );
        assert!(matches!(claude_outcome(&missing), Err(Failure::Failed(_))));
        let other = done(
            false,
            r#"{"is_error":true,"api_error_status":529,"result":"Overloaded"}"#,
            "",
        );
        assert_eq!(
            claude_outcome(&other),
            Err(Failure::Failed("Overloaded".into()))
        );
    }

    #[test]
    fn codex_ignores_plugin_noise_and_detects_sign_out() {
        let noise = "2026 ERROR rmcp::transport::worker: AuthRequired(...)\n";
        let ok = done(true, "", noise);
        assert_eq!(
            codex_outcome(Some("{\"clips\":[]}\n".into()), &ok),
            Ok("{\"clips\":[]}".into())
        );
        let out = done(false, "", &format!("{noise}ERROR: 401 Unauthorized"));
        assert_eq!(codex_outcome(None, &out), Err(Failure::SignedOut));
        let broken = done(false, "", &format!("{noise}stream disconnected"));
        assert_eq!(
            codex_outcome(None, &broken),
            Err(Failure::Failed("stream disconnected".into()))
        );
    }

    #[test]
    fn opencode_text_events_are_joined_and_errors_are_explained() {
        let events = concat!(
            "{\"type\":\"step_start\"}\n",
            "{\"type\":\"text\",\"part\":{\"text\":\"```json\\n{\\\"clips\\\":[{\\\"start\\\":1,\"}}\n",
            "{\"type\":\"text\",\"part\":{\"text\":\"\\\"end\\\":2,\\\"score\\\":5,\\\"reason\\\":\\\"x\\\"}]}\\n```\"}}\n",
        );
        let answer: Value =
            serde_json::from_str(&opencode_outcome(&done(true, events, "")).unwrap()).unwrap();
        assert_eq!(answer["clips"][0]["end"], 2);
        let limit = "{\"type\":\"error\",\"error\":{\"message\":\"Free usage limit reached. Connect a provider.\"}}\n";
        assert_eq!(
            opencode_outcome(&done(false, limit, "")),
            Err(Failure::Failed(
                "Free usage limit reached. Connect a provider.".into()
            ))
        );
        let none =
            "{\"type\":\"error\",\"error\":{\"message\":\"No model is available for session\"}}\n";
        assert_eq!(
            opencode_outcome(&done(false, none, "")),
            Err(Failure::SignedOut)
        );
    }

    #[test]
    fn stopped_runs_are_never_treated_as_answers() {
        let mut out = done(false, "", "");
        out.stopped = Stop::Canceled;
        assert_eq!(claude_outcome(&out), Err(Failure::Canceled));
        out.stopped = Stop::TimedOut;
        assert!(matches!(opencode_outcome(&out), Err(Failure::Failed(_))));
    }

    #[test]
    fn sign_in_state_is_read_from_each_tools_status_output() {
        assert_eq!(
            classify_signin(
                Provider::Claude,
                &done(true, "{\n \"loggedIn\": true\n}", "")
            ),
            Signin::In
        );
        assert_eq!(
            classify_signin(Provider::Claude, &done(false, "{\"loggedIn\": false}", "")),
            Signin::Out
        );
        assert_eq!(
            classify_signin(Provider::Claude, &done(true, "oops", "")),
            Signin::Unknown
        );
        assert_eq!(
            classify_signin(Provider::Codex, &done(true, "", "Logged in using ChatGPT")),
            Signin::In
        );
        assert_eq!(
            classify_signin(Provider::Codex, &done(false, "", "Not logged in")),
            Signin::Out
        );
        let listed = "\u{1b}[90mOpenAI\u{1b}[39m  OAuth  stored\n";
        assert_eq!(
            classify_signin(Provider::Opencode, &done(true, listed, "")),
            Signin::In
        );
        assert_eq!(
            classify_signin(Provider::Opencode, &done(true, "No credentials\n", "")),
            Signin::Out
        );
        let mut timed_out = done(true, "{\"loggedIn\": true}", "");
        timed_out.stopped = Stop::TimedOut;
        assert_eq!(
            classify_signin(Provider::Claude, &timed_out),
            Signin::Unknown
        );
    }

    #[test]
    fn replies_wrapped_in_prose_still_yield_json() {
        assert_eq!(
            extract_json("Sure!\n```json\n{\"a\":1}\n```"),
            Some("{\"a\":1}".into())
        );
        assert_eq!(extract_json("no json here"), None);
        assert_eq!(extract_json("{broken"), None);
    }

    #[test]
    fn only_https_links_to_assistant_sites_may_open() {
        assert!(allowed_url(
            "https://claude.com/cai/oauth/authorize?code=true&state=a"
        ));
        assert!(allowed_url("https://auth.openai.com/oauth/authorize?x=1"));
        assert!(allowed_url("https://opencode.ai"));
        assert!(!allowed_url("http://claude.com/"));
        assert!(!allowed_url("https://claude.com.evil.test/"));
        assert!(!allowed_url("https://evil.test/?u=https://claude.com"));
        assert!(!allowed_url("https://claude.com@evil.test/"));
        assert!(!allowed_url("https://evilclaude.com/"));
        assert!(!allowed_url("https://claude.com:abc/"));
        assert!(!allowed_url("https://claude.com/ x"));
        assert!(!allowed_url("file:///c:/windows/system32/calc.exe"));
        assert!(!allowed_url("javascript:alert(1)"));
    }

    #[test]
    fn sign_in_addresses_are_found_in_tool_output() {
        assert_eq!(
            find_url("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1"),
            Some("https://claude.com/cai/oauth/authorize?code=true&x=1".into())
        );
        assert_eq!(
            find_url("https://auth.openai.com/a?b=1.\n"),
            Some("https://auth.openai.com/a?b=1".into())
        );
        assert_eq!(find_url("Opening browser to sign in…"), None);
        assert_eq!(find_url("https://"), None);
    }

    #[test]
    fn programs_are_found_including_windows_shims() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        fs::write(second.path().join("codex.cmd"), "").unwrap();
        fs::write(second.path().join("claude.exe"), "").unwrap();
        fs::write(second.path().join("claude.cmd"), "").unwrap();
        let dirs = [first.path().to_path_buf(), second.path().to_path_buf()];
        assert_eq!(
            find_in(&dirs, "codex"),
            Some(second.path().join("codex.cmd"))
        );
        assert_eq!(
            find_in(&dirs, "claude"),
            Some(second.path().join("claude.exe"))
        );
        assert_eq!(find_in(&dirs, "opencode"), None);
    }

    #[test]
    fn model_names_cannot_be_mistaken_for_options() {
        assert_eq!(clean_model(None), Ok(None));
        assert_eq!(clean_model(Some("  ".into())), Ok(None));
        assert_eq!(
            clean_model(Some(" openai/gpt-5#high ".into())),
            Ok(Some("openai/gpt-5#high".into()))
        );
        assert!(clean_model(Some("--auto".into())).is_err());
        assert!(clean_model(Some("a b".into())).is_err());
        assert!(clean_model(Some("x".repeat(121))).is_err());
    }

    #[test]
    fn built_in_configuration_is_valid_json_and_denies_everything() {
        let schema: Value = serde_json::from_str(SCHEMA).unwrap();
        assert_eq!(
            schema["properties"]["clips"]["items"]["required"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        let config: Value = serde_json::from_str(OPENCODE_CONFIG).unwrap();
        let rules = &config["agents"][OPENCODE_AGENT]["permissions"];
        assert_eq!(rules.as_array().unwrap().len(), 1);
        assert_eq!(rules[0]["effect"], "deny");
        assert_eq!(rules[0]["action"], "*");
    }

    #[test]
    fn a_finished_command_is_captured_and_a_slow_one_is_stopped() {
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut quick = base_command(&shell);
        quick.args(["/d", "/c", "more"]);
        let out = run(
            &mut quick,
            Some(b"hello transcript\r\n".to_vec()),
            Duration::from_secs(20),
            None,
            false,
        )
        .unwrap();
        assert!(out.success && out.stdout.contains("hello transcript"));
        let mut slow = base_command(&shell);
        slow.args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]);
        let started = Instant::now();
        let out = run(&mut slow, None, Duration::from_millis(400), None, false).unwrap();
        assert_eq!(out.stopped, Stop::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn stopping_a_job_kills_the_whole_process_tree_promptly() {
        let shell = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut slow = base_command(&shell);
        slow.args(["/d", "/c", "ping -n 60 127.0.0.1 >nul"]);
        CANCEL.store(false, Ordering::SeqCst);
        let stopper = thread::spawn(|| {
            thread::sleep(Duration::from_millis(400));
            cancel_agent_job();
        });
        let started = Instant::now();
        let out = run(&mut slow, None, Duration::from_secs(60), None, true).unwrap();
        stopper.join().unwrap();
        CANCEL.store(false, Ordering::SeqCst);
        assert_eq!(out.stopped, Stop::Canceled);
        assert!(!out.success);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(ACTIVE_PID.load(Ordering::SeqCst), 0);
        assert_eq!(claude_outcome(&out), Err(Failure::Canceled));
    }

    #[test]
    fn console_sign_in_opens_a_titled_window_and_quotes_the_path() {
        let line = console_line(
            "OpenCode",
            Path::new(r"C:\Program Files\nodejs\opencode.cmd"),
            &["auth", "login"],
        );
        assert_eq!(
            line,
            r#"/d /c start "OpenCode sign-in" "C:\Program Files\nodejs\opencode.cmd" auth login"#
        );
        assert!(!line.contains("/wait"));
    }

    fn live(provider: Provider) {
        let quality = Quality::Fast;
        let result = ping_result(ask(provider, quality, None, PING, Duration::from_secs(150)));
        assert_eq!(result.health, Health::Ready, "{:?}", result.message);
    }

    #[test]
    #[ignore = "requires Claude Code signed in; sends one tiny request"]
    fn live_claude() {
        live(Provider::Claude);
    }

    #[test]
    #[ignore = "requires Codex signed in; sends one tiny request"]
    fn live_codex() {
        live(Provider::Codex);
    }

    #[test]
    #[ignore = "requires OpenCode with a connected provider; sends one tiny request"]
    fn live_opencode() {
        let model = std::env::var("MINIVIDCUT_TEST_OPENCODE_MODEL").ok();
        let result = ping_result(ask(
            Provider::Opencode,
            Quality::Fast,
            model.as_deref(),
            PING,
            Duration::from_secs(150),
        ));
        assert_eq!(result.health, Health::Ready, "{:?}", result.message);
    }
}
