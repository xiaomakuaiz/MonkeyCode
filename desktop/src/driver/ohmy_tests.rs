// OhmyAgentDriver 测试:E2E(mock 壳 + 真实 ohmyagent + 假 LLM)与
// journal/归一化单元测试(裸 Inner,不起引擎进程)。
// 经 ohmy.rs 的 #[path] 声明挂为 driver::ohmy::tests,super == ohmy。

use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::*;
use crate::config::DesktopConfig;
use crate::driver::frame;
use crate::driver::session::{SessionState, SessionsState};
use crate::driver::subagent::SubagentState;
use crate::driver::transport::{find_ohmyagent, spawn_journal_writer, TransportState};


/// E2E 串行锁:两个 E2E 都改进程级 HOME/XDG 环境变量,并行会互踩
static E2E_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn sse_event(name: &str, data: Value) -> String {
    format!("event: {name}\ndata: {data}")
}

fn sse_head() -> Vec<String> {
    vec![sse_event(
        "message_start",
        json!({"type":"message_start","message":{"id":"m1","role":"assistant","content":[],"model":"test-model","usage":{"input_tokens":10,"output_tokens":0}}}),
    )]
}

fn sse_tail(stop_reason: &str) -> Vec<String> {
    vec![
        sse_event("content_block_stop", json!({"type":"content_block_stop","index":0})),
        sse_event(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":5}}),
        ),
        sse_event("message_stop", json!({"type":"message_stop"})),
    ]
}

/// 一段纯文本流式应答(end_turn)。
fn sse_text(text: &str) -> String {
    let mut ev = sse_head();
    ev.push(sse_event(
        "content_block_start",
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
    ));
    ev.push(sse_event(
        "content_block_delta",
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
    ));
    ev.extend(sse_tail("end_turn"));
    ev.join("\n\n") + "\n\n"
}

/// 一次工具调用流式应答(stop_reason=tool_use)。
fn sse_tool_use(tu_id: &str, name: &str, input: &Value) -> String {
    let mut ev = sse_head();
    ev.push(sse_event(
        "content_block_start",
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":tu_id,"name":name,"input":{}}}),
    ));
    ev.push(sse_event(
        "content_block_delta",
        json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":input.to_string()}}),
    ));
    ev.extend(sse_tail("tool_use"));
    ev.join("\n\n") + "\n\n"
}

/// 假 Anthropic SSE 服务:按请求序回放 steps(超出重复最后一步);
/// delay_ms > 0 时应答前挂起(模拟慢模型,测运行中停止的和解)。
fn fake_anthropic_steps(delay_ms: u64, steps: Vec<String>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            let n = counter.fetch_add(1, Ordering::Relaxed);
            let sse = steps[n.min(steps.len() - 1)].clone();
            std::thread::spawn(move || {
                use std::io::{BufRead as _, Write as _};
                if delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }
                let mut reader = std::io::BufReader::new(conn.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let mut content_len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_len];
                use std::io::Read as _;
                let _ = reader.read_exact(&mut body);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    sse.len(),
                    sse
                );
                let _ = conn.write_all(resp.as_bytes());
            });
        }
    });
    format!("http://{addr}")
}

/// 端到端:mock 壳 + 真实 ohmyagent + 假 LLM,验证 create → send → 归一化
/// 帧日志(user-input/task-started/agent 文本/task-ended)与回放。
/// 需要 ohmyagent 二进制:MC_OHMYAGENT_BIN 或 PATH;找不到则跳过。
struct TestCtx(PathBuf);
impl ShellCtx for TestCtx {
    fn emit_json(&self, _event: &str, _payload: Value) {}
    fn config_dir(&self) -> Result<PathBuf, String> {
        Ok(self.0.clone())
    }
}

/// 隔离 HOME(ohmyagent 配置/会话)与壳配置目录,写配置并起驱动。
/// 改进程级环境变量,须持 E2E_LOCK 后调用。
fn e2e_setup(tag: &str, llm_delay_ms: u64) -> (OhmyDriver, PathBuf) {
    e2e_setup_steps(tag, llm_delay_ms, vec![sse_text("你好,任务完成")])
}

fn e2e_setup_steps(tag: &str, llm_delay_ms: u64, steps: Vec<String>) -> (OhmyDriver, PathBuf) {
    let home = std::env::temp_dir().join(format!("ohmy-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    // 引擎配置写进壳私有目录(driver 会以 OHMYAGENT_CONFIG_DIR 注入)
    std::fs::create_dir_all(home.join("shellcfg/ohmyagent")).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("XDG_CONFIG_HOME", home.join("xdg"));

    let llm = fake_anthropic_steps(llm_delay_ms, steps);
    let settings = json!({
        "default_model": "测试模型",
        "permission_mode": "default",
        "models": { "测试模型": { "type": "anthropic", "model": "test-model",
            "api_key": "sk-fake", "base_url": format!("{llm}/api/anthropic"),
            "context_window": 200000 } },
    });
    std::fs::write(
        home.join("shellcfg/ohmyagent/settings.json"),
        serde_json::to_vec_pretty(&settings).unwrap(),
    )
    .unwrap();

    let ctx: Arc<dyn ShellCtx> = Arc::new(TestCtx(home.join("shellcfg")));
    let cfg = DesktopConfig {
        models: json!([{ "name": "测试模型", "provider": "anthropic",
            "base_url": format!("{llm}/api/anthropic"), "api_key": "sk-fake", "model": "test-model", "default": true }]),
        ..Default::default()
    };
    let driver = OhmyDriver::start_with(ctx, &cfg).expect("引擎启动");
    (driver, home)
}

#[tokio::test(flavor = "multi_thread")]
async fn e2e_chat_normalization() {
    if find_ohmyagent().is_none() {
        eprintln!("skip: 未找到 ohmyagent 二进制");
        return;
    }
    let _g = E2E_LOCK.lock().unwrap();
    let (driver, home) = e2e_setup("chat", 0);

    let workdir = home.to_string_lossy().into_owned();
    let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
    // 契约 5:新建未运行的会话是 created(不是 finished)
    assert_eq!(meta.get("status").and_then(|v| v.as_str()), Some("created"));
    let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
    driver.session_open(&sid).await.expect("打开会话");

    let payload = json!({ "content": frame::b64_text("写个 hello world") });
    driver.session_send(&sid, "user-input", payload).await.expect("发送");

    // 轮询帧日志直到 task-ended(假 LLM 一轮即完)
    let mut journal: Vec<Value> = vec![];
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        journal = driver.read_journal(&sid);
        if journal.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("task-ended")) {
            break;
        }
    }
    let types: Vec<&str> = journal.iter().filter_map(|f| f.get("type").and_then(|v| v.as_str())).collect();
    assert!(types.contains(&"task-started"), "缺 task-started: {types:?}");
    assert!(types.contains(&"user-input"), "缺 user-input: {types:?}");
    assert!(types.contains(&"task-ended"), "缺 task-ended: {types:?}");
    // agent 文本增量以 acp_event 形态出现,data 内联对象是 agent_message_chunk
    let has_text = journal.iter().any(|f| {
        if f.get("kind").and_then(|v| v.as_str()) != Some("acp_event") {
            return false;
        }
        let Some(v) = f.get("data").filter(|d| d.is_object()) else { return false };
        v.get("update").and_then(|u| u.get("sessionUpdate")).and_then(|s| s.as_str())
            == Some("agent_message_chunk")
            && v["update"]["content"]["text"].as_str().map(|t| t.contains("任务完成")).unwrap_or(false)
    });
    assert!(has_text, "缺 agent 文本帧: {journal:?}");
    // 轮后上下文占用帧(turn/stopped.context,296176a):used>0,window=清单值
    let has_usage = journal
        .iter()
        .filter_map(acp_update)
        .any(|u| {
            u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("usage_update")
                && u.get("used").and_then(|v| v.as_i64()).unwrap_or(0) > 0
                && u.get("size").and_then(|v| v.as_i64()) == Some(200000)
        });
    assert!(has_usage, "缺上下文占用帧: {journal:?}");
    // seq 单调
    let seqs: Vec<u64> = journal.iter().filter_map(|f| f.get("seq").and_then(|v| v.as_u64())).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "seq 不单调: {seqs:?}");

    // 会话列表(sidecar 权威):标题取首条输入,状态 finished
    let list = driver.sessions_list().await.unwrap();
    let items = list.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].get("status").and_then(|v| v.as_str()), Some("finished"));
    assert!(items[0].get("title").and_then(|v| v.as_str()).unwrap_or("").contains("hello world"));

    // session/switchMode、session/switchModel 通路(会话已激活,走原生 RPC)
    driver
        .session_call(&sid, "session_set_mode", json!({ "mode": "yolo" }))
        .await
        .expect("切权限模式");
    driver
        .session_call(&sid, "session_set_model", json!({ "model": "测试模型" }))
        .await
        .expect("切模型");

    // sessionQuery 通路:resume 可用性经 session/exists RPC 判定
    // (存在/不存在两侧;壳不再探测引擎存储的文件布局)
    assert!(driver.engine_session_exists(&sid).await, "跑过一轮的会话应 resume 可用");
    assert!(!driver.engine_session_exists("no-such-session").await, "未知会话应为 false");

    driver.stop();
}

/// 运行中停止引擎必须本地和解:补收尾帧、sidecar 落 interrupted——
/// 否则会话永久卡"执行中"(不能发/不能删/不能切,重启也救不回)。
#[tokio::test(flavor = "multi_thread")]
async fn e2e_stop_reconciles_running_session() {
    if find_ohmyagent().is_none() {
        eprintln!("skip: 未找到 ohmyagent 二进制");
        return;
    }
    let _g = E2E_LOCK.lock().unwrap();
    // 慢速假 LLM(8s,超过引擎 5s 的内部 shutdown 预算):轮次挂在模型
    // 调用上。stop() 预算 = 引擎宣告 grace(5s)+ 3s 余量,引擎会在
    // 5s 强制收敛后优雅退出,壳等得到;等不到(引擎挂死)才 kill
    let (driver, home) = e2e_setup("stop", 8000);

    let workdir = home.to_string_lossy().into_owned();
    let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
    let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
    driver.session_open(&sid).await.expect("打开会话");
    let payload = json!({ "content": frame::b64_text("会被挂住的任务") });
    driver.session_send(&sid, "user-input", payload).await.expect("发送");

    driver.stop();

    let journal = driver.read_journal(&sid);
    let types: Vec<&str> = journal.iter().filter_map(|f| f.get("type").and_then(|v| v.as_str())).collect();
    assert!(types.contains(&"task-started"), "缺 task-started: {types:?}");
    assert!(types.contains(&"task-error"), "停止未补 task-error: {types:?}");
    assert!(types.contains(&"task-ended"), "停止未补 task-ended: {types:?}");
    let meta = driver.0.read_sidecar(&sid);
    assert_eq!(
        meta.get("status").and_then(|v| v.as_str()),
        Some("interrupted"),
        "sidecar 未落 interrupted: {meta:?}"
    );
}

/// 轮询帧日志直到谓词命中(100ms × 150 = 15s 上限)。
async fn wait_journal(driver: &OhmyDriver, sid: &str, pred: impl Fn(&[Value]) -> bool) -> Vec<Value> {
    let mut journal = vec![];
    for _ in 0..150 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        journal = driver.read_journal(sid);
        if pred(&journal) {
            break;
        }
    }
    journal
}

fn acp_update(f: &Value) -> Option<Value> {
    if f.get("kind").and_then(|v| v.as_str()) != Some("acp_event") {
        return None;
    }
    f.get("data")?.get("update").cloned()
}

/// AskUserQuestion 全链路:deferred 工具经 ToolSearch 载入 → 引擎
/// question/request → 壳 acp_ask_user_question 帧 → 答复 → 轮次完成。
#[tokio::test(flavor = "multi_thread")]
async fn e2e_ask_user_question_flow() {
    if find_ohmyagent().is_none() {
        eprintln!("skip: 未找到 ohmyagent 二进制");
        return;
    }
    let _g = E2E_LOCK.lock().unwrap();
    let steps = vec![
        sse_tool_use("tu_1", "ToolSearch", &json!({ "query": "AskUserQuestion" })),
        sse_tool_use("tu_2", "AskUserQuestion", &json!({ "questions": [{
            "question": "选哪个?", "header": "选择",
            "options": [{"label":"A","description":"甲"},{"label":"B","description":"乙"}],
            "multiSelect": false }] })),
        sse_text("好的,按 A 处理"),
    ];
    let (driver, home) = e2e_setup_steps("ask", 0, steps);
    let workdir = home.to_string_lossy().into_owned();
    let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
    let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
    driver.session_open(&sid).await.expect("打开会话");
    driver.session_call(&sid, "session_set_mode", json!({ "mode": "yolo" })).await.expect("yolo");
    driver
        .session_send(&sid, "user-input", json!({ "content": frame::b64_text("问我一个问题") }))
        .await
        .expect("发送");

    // 提问卡帧落日志,取 request_id
    let journal = wait_journal(&driver, &sid, |j| {
        j.iter().any(|f| f.get("kind").and_then(|v| v.as_str()) == Some("acp_ask_user_question"))
    })
    .await;
    let req_id = journal
        .iter()
        .filter(|f| f.get("kind").and_then(|v| v.as_str()) == Some("acp_ask_user_question"))
        .filter_map(|f| f.get("data").cloned())
        .filter_map(|v| {
            v.get("toolCall")
                .and_then(|t| t.get("toolCallId"))
                .and_then(|i| i.as_str())
                .map(String::from)
        })
        .next()
        .unwrap_or_default();
    assert!(!req_id.is_empty(), "未收到提问卡帧,journal: {journal:?}");

    // 答复 → 轮次完成,答案回显帧在日志(回放可见)
    driver
        .session_send(
            &sid,
            "reply-question",
            json!({ "request_id": req_id, "answers_json": "{\"选哪个?\":\"A\"}", "cancelled": false }),
        )
        .await
        .expect("答复");
    let journal = wait_journal(&driver, &sid, |j| {
        j.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("task-ended"))
    })
    .await;
    let types: Vec<&str> =
        journal.iter().filter_map(|f| f.get("type").and_then(|v| v.as_str())).collect();
    assert!(types.contains(&"reply-question"), "缺答案回显帧: {types:?}");
    assert!(types.contains(&"task-ended"), "轮次未完成: {types:?}");
    driver.stop();
}

/// 构造裸 Inner(不起引擎进程):journal 写线程 + 会话表,专测回放窗口
/// 与句柄生命周期,不依赖 ohmyagent 二进制。
fn bare_inner(tag: &str) -> Arc<Inner> {
    let home = std::env::temp_dir().join(format!("ohmy-journal-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let data_dir = home.join("ohmy-sessions");
    std::fs::create_dir_all(&data_dir).unwrap();
    let (stdin_tx, _stdin_rx) = mpsc::unbounded_channel();
    Arc::new(Inner {
        app: Arc::new(TestCtx(home.clone())),
        transport: TransportState {
            child: StdMutex::new(None),
            stdin_tx,
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            journal_tx: spawn_journal_writer(data_dir.clone()),
            engine_caps: StdMutex::new(HashSet::new()),
            shutdown_grace_ms: AtomicI64::new(5000),
            stopped: Arc::new(AtomicBool::new(false)),
        },
        sess: SessionsState {
            sessions: StdMutex::new(HashMap::new()),
            batch: Arc::new(StdMutex::new(HashMap::new())),
            perm_remember: StdMutex::new(HashSet::new()),
            pending_questions: StdMutex::new(HashMap::new()),
            pending_perms: StdMutex::new(HashMap::new()),
            perm_tools: StdMutex::new(HashMap::new()),
        },
        sub: SubagentState {
            subagents: StdMutex::new(HashMap::new()),
            agent_results: StdMutex::new(HashMap::new()),
            agent_inputs: StdMutex::new(HashMap::new()),
        },
        models: vec![],
        data_dir,
        engine_dir: home.join("ohmyagent"),
        perm_persist_path: home.join("perm.json"),
    })
}

fn bare_session(sid: &str) -> SessionState {
    SessionState {
        seq: 0,
        running: true,
        created: true,
        engine_id: sid.to_string(),
        opened: false,
        open_tools: HashMap::new(),
        model_text: String::new(),
        last_event_seq: 0,
        workdir: String::new(),
        model_name: String::new(),
        mode: "default".into(),
        title: String::new(),
    }
}

/// 回放窗口不丢帧(修复:旧实现 opened=false 期间到达的帧只入日志
/// 不入缓冲,读完日志才置 opened=true,窗口内的帧 UI 看不到):
/// 并发推帧线程贯穿整个回放过程,回放结果 + 之后的 batch 缓冲按 seq
/// 拼接必须恰好覆盖 1..=N,无缺口无重复;journal 落盘侧同样完整有序。
#[test]
fn replay_window_no_frame_loss() {
    let inner = bare_inner("replay");
    inner.sess.sessions.lock().unwrap().insert("s1".into(), bare_session("s1"));
    // 预置 50 帧历史(opened=false → 只落盘)
    for _ in 0..50 {
        inner.push_frame("s1", |seq| json!({ "type": "t", "seq": seq }));
    }
    // 并发推帧:覆盖回放的读盘窗口
    let inner2 = inner.clone();
    let pusher = std::thread::spawn(move || {
        for _ in 0..200 {
            inner2.push_frame("s1", |seq| json!({ "type": "t", "seq": seq }));
            std::thread::sleep(Duration::from_micros(200));
        }
    });
    std::thread::sleep(Duration::from_millis(5)); // 让并发流先跑起来
    let replay = inner.replay_open("s1");
    pusher.join().unwrap();
    let rseqs: Vec<u64> =
        replay.iter().filter_map(|f| f.get("seq").and_then(|v| v.as_u64())).collect();
    assert!(rseqs.len() >= 50, "回放至少含预置帧: {}", rseqs.len());
    assert_eq!(rseqs.first(), Some(&1));
    assert!(rseqs.windows(2).all(|w| w[1] == w[0] + 1), "回放帧 seq 不连续: {rseqs:?}");
    // opened=true 之后的帧全部进 batch,与回放结果无缝衔接
    let batched: Vec<u64> = inner
        .sess.batch
        .lock()
        .unwrap()
        .get("s1")
        .map(|v| v.iter().filter_map(|f| f.get("seq").and_then(|x| x.as_u64())).collect())
        .unwrap_or_default();
    let mut all = rseqs;
    all.extend(batched);
    assert_eq!(all, (1..=250).collect::<Vec<u64>>(), "回放+缓冲拼接有缺口/重复");
    // 落盘侧同样完整:屏障后日志恰 250 行且 seq 连续(写线程按投递序追加)
    inner.journal_barrier();
    let data =
        std::fs::read_to_string(inner.data_dir.join("s1").join("events.jsonl")).unwrap();
    let jseqs: Vec<u64> = data
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|f| f.get("seq").and_then(|v| v.as_u64()))
        .collect();
    assert_eq!(jseqs, (1..=250).collect::<Vec<u64>>(), "journal 落盘不完整/乱序");
}

/// 删除路径契约:journal_close(wait=true) 先排空该会话余帧、关句柄,
/// 之后目录才可安全移除(Windows 上打开中的文件删不掉目录)。
#[test]
fn journal_close_drains_before_delete() {
    let inner = bare_inner("close");
    inner.sess.sessions.lock().unwrap().insert("s1".into(), bare_session("s1"));
    for _ in 0..20 {
        inner.push_frame("s1", |seq| json!({ "type": "t", "seq": seq }));
    }
    inner.sess.sessions.lock().unwrap().remove("s1"); // 删除路径先摘会话,不再产新帧
    inner.journal_close("s1", true);
    let dir = inner.data_dir.join("s1");
    let n = std::fs::read_to_string(dir.join("events.jsonl")).unwrap().lines().count();
    assert_eq!(n, 20, "close 前入队的帧须全部落盘");
    std::fs::remove_dir_all(&dir).expect("句柄已关,目录可删");
    assert!(!dir.exists());
}

/// SubAgent 进度:上游转发的子循环事件(未知随机 session_id)被认领到
/// 父会话,归一化为 Agent 工具卡的 progress feed(subagent_text 行)。
#[tokio::test(flavor = "multi_thread")]
async fn e2e_subagent_progress() {
    if find_ohmyagent().is_none() {
        eprintln!("skip: 未找到 ohmyagent 二进制");
        return;
    }
    let _g = E2E_LOCK.lock().unwrap();
    let steps = vec![
        sse_tool_use("tu_1", "Agent", &json!({ "prompt": "调查并汇报", "description": "调查任务" })),
        sse_text("子代理调查结果:一切正常\n"),
        sse_text("父任务完成"),
    ];
    let (driver, home) = e2e_setup_steps("sub", 0, steps);
    let workdir = home.to_string_lossy().into_owned();
    let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
    let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
    driver.session_open(&sid).await.expect("打开会话");
    driver.session_call(&sid, "session_set_mode", json!({ "mode": "yolo" })).await.expect("yolo");
    driver
        .session_send(&sid, "user-input", json!({ "content": frame::b64_text("派个子代理") }))
        .await
        .expect("发送");

    let journal = wait_journal(&driver, &sid, |j| {
        j.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("task-ended"))
    })
    .await;
    // Agent 工具卡存在且完成;标题带 description 标签(TUI 面板同源)
    let agent_done = journal.iter().filter_map(acp_update).any(|u| {
        u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("tool_call_update")
            && u.get("toolCallId").and_then(|v| v.as_str()) == Some("tu_1")
            && u.get("status").and_then(|v| v.as_str()) == Some("completed")
    });
    assert!(agent_done, "Agent 工具未完成: {journal:?}");
    let agent_titled = journal.iter().filter_map(acp_update).any(|u| {
        u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("tool_call")
            && u.get("toolCallId").and_then(|v| v.as_str()) == Some("tu_1")
            && u.get("title").and_then(|v| v.as_str()).map(|t| t.contains("调查任务")).unwrap_or(false)
    });
    assert!(agent_titled, "Agent 卡标题缺 description 标签: {journal:?}");
    // 子代理文本行以 progress feed 形态挂在 Agent 工具卡上
    let has_sub_text = journal.iter().filter_map(acp_update).any(|u| {
        u.get("toolCallId").and_then(|v| v.as_str()) == Some("tu_1")
            && u.get("progress").and_then(|p| p.get("kind")).and_then(|v| v.as_str())
                == Some("subagent_text")
            && u.get("progress")
                .and_then(|p| p.get("line"))
                .and_then(|v| v.as_str())
                .map(|l| l.contains("子代理调查结果"))
                .unwrap_or(false)
    });
    assert!(has_sub_text, "缺子代理进度行: {journal:?}");
    // 子会话物化:父卡有 child_session 链接,子 journal 形状完整可回放
    let child_id = journal
        .iter()
        .filter_map(acp_update)
        .find_map(|u| {
            if u.get("toolCallId").and_then(|v| v.as_str()) != Some("tu_1") {
                return None;
            }
            let p = u.get("progress")?;
            if p.get("kind").and_then(|v| v.as_str()) != Some("child_session") {
                return None;
            }
            p.get("childSessionId").and_then(|v| v.as_str()).map(String::from)
        })
        .expect("缺 child_session 链接");
    let ctypes: Vec<String> = driver
        .read_journal(&child_id)
        .iter()
        .filter_map(|f| f.get("type").and_then(|v| v.as_str()).map(String::from))
        .collect();
    for t in ["user-input", "task-started", "task-ended"] {
        assert!(ctypes.iter().any(|x| x == t), "子会话缺 {t}: {ctypes:?}");
    }
    // 子会话不进会话列表(经父卡点开)
    let list = driver.sessions_list().await.unwrap();
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .all(|s| s.get("id").and_then(|v| v.as_str()) != Some(child_id.as_str())),
        "子会话不应出现在列表"
    );
    driver.stop();
}

/// 审批记忆迁移引擎(permissionRemember):UI 勾选"记住"映射为
/// permission/respond.remember=true——引擎按命令段粒度记成项目级规则
/// (cwd/.ohmyagent/settings.json),二次同命令不再弹卡;壳侧不再记忆,
/// 持久化文件停用。
#[tokio::test(flavor = "multi_thread")]
async fn e2e_perm_remember_engine_rules() {
    if find_ohmyagent().is_none() {
        eprintln!("skip: 未找到 ohmyagent 二进制");
        return;
    }
    let _g = E2E_LOCK.lock().unwrap();
    // git push 不在引擎安全命令白名单 → default 模式必弹审批;
    // 同一命令连发两次:第一次批准并记住,第二次考验引擎侧规则
    let steps = vec![
        sse_tool_use("tu_1", "Bash", &json!({ "command": "git push origin main" })),
        sse_tool_use("tu_2", "Bash", &json!({ "command": "git push origin main" })),
        sse_text("推送完成"),
    ];
    let (driver, home) = e2e_setup_steps("perm", 0, steps);
    let workdir = home.to_string_lossy().into_owned();
    let meta = driver.session_create(&workdir, "测试模型", false).await.expect("建会话");
    let sid = meta.get("id").and_then(|v| v.as_str()).unwrap().to_string();
    driver.session_open(&sid).await.expect("打开会话");
    driver
        .session_send(&sid, "user-input", json!({ "content": frame::b64_text("推送代码") }))
        .await
        .expect("发送");

    // 首个 Bash 调用弹审批卡
    let journal = wait_journal(&driver, &sid, |j| {
        j.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("permission-req"))
    })
    .await;
    let req_id = journal
        .iter()
        .filter(|f| f.get("type").and_then(|v| v.as_str()) == Some("permission-req"))
        .filter_map(|f| f.get("data").cloned())
        .filter_map(|v| v.get("id").and_then(|i| i.as_str()).map(String::from))
        .next()
        .unwrap_or_default();
    assert!(!req_id.is_empty(), "未收到审批卡帧: {journal:?}");

    // 批准并勾选"记住"(persist 档与 remember 档同映射引擎单档)
    driver
        .session_send(
            &sid,
            "permission-resp",
            json!({ "id": req_id, "approved": true, "remember": true, "persist": true }),
        )
        .await
        .expect("审批");

    let journal = wait_journal(&driver, &sid, |j| {
        j.iter().any(|f| f.get("type").and_then(|v| v.as_str()) == Some("task-ended"))
    })
    .await;
    let types: Vec<&str> =
        journal.iter().filter_map(|f| f.get("type").and_then(|v| v.as_str())).collect();
    assert!(types.contains(&"task-ended"), "轮次未完成: {types:?}");
    // 引擎侧规则生效:二次同命令不再弹卡,审批卡帧全程只出现一次
    let perm_reqs = types.iter().filter(|t| **t == "permission-req").count();
    assert_eq!(perm_reqs, 1, "引擎规则未生效,二次同命令又弹卡: {types:?}");
    // 规则由引擎持久化到项目设置(命令段粒度 Bash(git push *))
    let rules =
        std::fs::read_to_string(home.join(".ohmyagent").join("settings.json")).unwrap_or_default();
    assert!(rules.contains("Bash(git push"), "项目设置缺命令段规则: {rules}");
    // 壳侧持久化文件停用(旧路径才写 ohmy-perm-remember.json)
    assert!(!driver.0.perm_persist_path.exists(), "壳侧审批记忆文件不应再写");
    driver.stop();
}

/// modelDoneText 全文对账:delta 被背压丢弃时,model_done 的权威全文
/// 以壳侧累积为前缀——缺口经正规产帧路径补成增量帧,journal 完整;
/// 完全不一致则不注入(仅日志外显)。
#[test]
fn model_done_reconciles_dropped_deltas() {
    let inner = bare_inner("mdone");
    inner.transport.engine_caps.lock().unwrap().insert("modelDoneText".into());
    inner.sess.sessions.lock().unwrap().insert("s1".into(), bare_session("s1"));
    let ev = |t: &str, data: Value| json!({ "type": t, "session_id": "s1", "data": data });
    inner.handle_event(ev("model_start", Value::Null));
    inner.handle_event(ev("model_delta", json!({ "text": "你好" })));
    // 「,世界」的 delta 被引擎背压丢弃……全文经 model_done 找回
    inner.handle_event(ev("model_done", json!({ "text": "你好,世界" })));
    // 第二段:累积与全文完全不一致 → 不注入
    inner.handle_event(ev("model_start", Value::Null));
    inner.handle_event(ev("model_delta", json!({ "text": "abc" })));
    inner.handle_event(ev("model_done", json!({ "text": "xyz" })));
    inner.journal_barrier();
    let data =
        std::fs::read_to_string(inner.data_dir.join("s1").join("events.jsonl")).unwrap();
    let texts: Vec<String> = data
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|f| acp_update(&f))
        .filter(|u| u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agent_message_chunk"))
        .filter_map(|u| u["content"]["text"].as_str().map(String::from))
        .collect();
    assert_eq!(texts, vec!["你好", ",世界", "abc"], "对账补帧不符");
}

/// structuredToolResult:失败判定用 is_error 结构位(不再嗅探 "Error: "
/// 前缀);Agent 工具卡内容以 agent_result 事件的全量 content 为权威
/// (tool_result 截断 500 字符可能把结果 JSON 截成半截)。
#[test]
fn structured_tool_result_and_agent_result() {
    let inner = bare_inner("sres");
    inner.transport.engine_caps.lock().unwrap().insert("structuredToolResult".into());
    inner.sess.sessions.lock().unwrap().insert("s1".into(), bare_session("s1"));
    let ev = |t: &str, tc: &str, data: Value| {
        json!({ "type": t, "session_id": "s1", "tool_call_id": tc, "data": data })
    };
    // is_error=true 但内容无 "Error: " 前缀 → 仍判失败
    inner.handle_event(ev("tool_call", "tc1", json!({ "name": "Bash", "input": { "command": "x" } })));
    inner.handle_event(ev("tool_result", "tc1", json!({ "tool": "Bash", "content": "exit 1", "is_error": true })));
    // Agent:agent_result 全量内容(远超 500 截断)为权威,tool_result
    // 侧只回了截断破损的半截 JSON
    inner.handle_event(ev("tool_call", "tc2", json!({ "name": "Agent", "input": { "description": "d", "prompt": "p" } })));
    let full = "结".repeat(600);
    inner.handle_event(ev(
        "agent_result",
        "tc2",
        json!({ "status": "completed", "agentId": "a1", "agentType": "explore", "content": full }),
    ));
    inner.handle_event(ev("tool_result", "tc2", json!({ "tool": "Agent", "content": "{\"status\":\"comp", "is_error": false })));
    inner.journal_barrier();
    let data =
        std::fs::read_to_string(inner.data_dir.join("s1").join("events.jsonl")).unwrap();
    let updates: Vec<Value> = data
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|f| acp_update(&f))
        .filter(|u| u.get("sessionUpdate").and_then(|v| v.as_str()) == Some("tool_call_update"))
        .collect();
    let tc1 = updates
        .iter()
        .find(|u| u.get("toolCallId").and_then(|v| v.as_str()) == Some("tc1"))
        .expect("缺 tc1 收尾帧");
    assert_eq!(tc1.get("status").and_then(|v| v.as_str()), Some("failed"), "is_error 未判失败");
    let tc2 = updates
        .iter()
        .find(|u| u.get("toolCallId").and_then(|v| v.as_str()) == Some("tc2"))
        .expect("缺 tc2 收尾帧");
    assert_eq!(tc2.get("status").and_then(|v| v.as_str()), Some("completed"));
    assert_eq!(
        tc2.get("rawOutput").and_then(|v| v.as_str()),
        Some(full.as_str()),
        "Agent 结果未采用 agent_result 全量内容"
    );
}

/// 无 parent_session_id 戳记的子代理事件不再猜测认领(旧启发式按
/// "运行中且持有未闭合 Agent 工具的会话"猜,并发多 Agent 会挂错父卡):
/// 未知会话 + 无戳记 → 丢弃;带戳记 → 精确认领。
#[test]
fn unstamped_subagent_event_not_claimed() {
    let inner = bare_inner("unst");
    let mut s = bare_session("s1");
    s.open_tools.insert("tc1".into(), "Agent".into());
    inner.sess.sessions.lock().unwrap().insert("s1".into(), s);
    // 旧启发式条件齐备(运行中 + 未闭合 Agent 工具)也不认领
    inner.handle_event(json!({ "type": "model_delta", "session_id": "child9", "data": { "text": "hi" } }));
    assert!(!inner.sess.sessions.lock().unwrap().contains_key("child9"), "无戳记事件不应物化子会话");
    assert!(inner.sub.subagents.lock().unwrap().is_empty());
    // 带戳记则精确认领
    inner.handle_event(json!({ "type": "model_delta", "session_id": "child9",
        "parent_session_id": "s1", "parent_tool_call_id": "tc1", "data": { "text": "hi" } }));
    assert!(inner.sess.sessions.lock().unwrap().contains_key("child9"), "带戳记事件应认领");
    assert_eq!(
        inner.sub.subagents.lock().unwrap().get("child9").map(|r| r.parent_tc.clone()),
        Some("tc1".into())
    );
}
