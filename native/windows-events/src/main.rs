use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::sync::{Mutex, OnceLock, mpsc};
use std::thread;

use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Networking::Connectivity::{
    NetworkConnectivityLevel, NetworkInformation, NetworkStatusChangedEventHandler,
};
use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    HPOWERNOTIFY, POWERBROADCAST_SETTING, RegisterPowerSettingNotification,
    UnregisterPowerSettingNotification,
};
use windows::Win32::System::SystemInformation::GetSystemTime;
use windows::Win32::System::SystemServices::GUID_SESSION_DISPLAY_STATUS;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DEVICE_NOTIFY_WINDOW_HANDLE, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetMessageW, MSG, PBT_POWERSETTINGCHANGE, PostMessageW, PostQuitMessage, RegisterClassW,
    TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WM_POWERBROADCAST,
    WNDCLASSW,
};
use windows::core::{PCWSTR, w};

static OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SCREEN_STATE: OnceLock<Mutex<Option<bool>>> = OnceLock::new();
static NETWORK_STATE: OnceLock<Mutex<Option<bool>>> = OnceLock::new();

fn main() {
    let screen = match ScreenListener::new() {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("无法初始化屏幕电源事件监听：{error}");
            std::process::exit(1);
        }
    };

    let network = match NetworkListener::new() {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("无法初始化网络状态事件监听：{error}");
            std::process::exit(1);
        }
    };

    let media = MediaListener::start();

    // 监听标准输入关闭：父进程退出时自动结束辅助程序。
    let hwnd_raw = screen.hwnd.0 as usize;
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut line = String::new();
        let mut handle = stdin.lock();
        while matches!(handle.read_line(&mut line), Ok(bytes) if bytes > 0) {
            line.clear();
        }
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd_raw as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    });

    unsafe {
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    drop(media);
    drop(network);
    drop(screen);
}

fn utc_now_iso() -> String {
    let st = unsafe { GetSystemTime() };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
    )
}

fn json_escape(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len() + 2);
    escaped.push('"');
    for ch in input.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(escaped, "\\u{:04x}", c as u32);
            }
            c => escaped.push(c),
        }
    }
    escaped.push('"');
    escaped
}

fn format_event_json(kind: &str, state: bool, source: Option<&str>, triggered_at: &str) -> String {
    match source {
        Some(app_id) => format!(
            "{{\"event\":\"{kind}\",\"state\":{state},\"triggeredAt\":\"{triggered_at}\",\"appId\":{}}}",
            json_escape(app_id)
        ),
        None => format!(
            "{{\"event\":\"{kind}\",\"state\":{state},\"triggeredAt\":\"{triggered_at}\"}}"
        ),
    }
}

fn publish(kind: &str, state: bool, source: Option<&str>) {
    let line = format_event_json(kind, state, source, &utc_now_iso());
    let _guard = OUTPUT_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

struct NetworkListener {
    token: i64,
}

impl NetworkListener {
    fn new() -> windows::core::Result<Self> {
        let handler = NetworkStatusChangedEventHandler::new(|_| {
            Self::check_and_publish();
            Ok(())
        });
        let token = NetworkInformation::NetworkStatusChanged(&handler)?;
        Self::check_and_publish();
        Ok(Self { token })
    }

    fn check_and_publish() {
        let state = NetworkInformation::GetInternetConnectionProfile()
            .ok()
            .and_then(|profile| profile.GetNetworkConnectivityLevel().ok())
            == Some(NetworkConnectivityLevel::InternetAccess);

        let mut changed = None;
        {
            let mut guard = NETWORK_STATE.get_or_init(|| Mutex::new(None)).lock().unwrap();
            if let Some(previous) = *guard
                && previous != state
            {
                changed = Some(state);
            }
            *guard = Some(state);
        }
        if let Some(current) = changed {
            publish(if current { "online" } else { "offline" }, current, None);
        }
    }
}

impl Drop for NetworkListener {
    fn drop(&mut self) {
        let _ = NetworkInformation::RemoveNetworkStatusChanged(self.token);
    }
}

enum MediaMsg {
    Refresh,
    PlaybackChanged,
    Shutdown,
}

struct MediaListener {
    tx: mpsc::Sender<MediaMsg>,
    worker: Option<thread::JoinHandle<()>>,
}

impl MediaListener {
    fn start() -> Self {
        let (tx, rx) = mpsc::channel();
        let worker_tx = tx.clone();
        let worker = thread::spawn(move || {
            let com_initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
            Self::run_loop(worker_tx, rx);
            if com_initialized {
                unsafe { CoUninitialize() };
            }
        });
        Self {
            tx,
            worker: Some(worker),
        }
    }

    fn run_loop(tx: mpsc::Sender<MediaMsg>, rx: mpsc::Receiver<MediaMsg>) {
        let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .and_then(|op| op.join())
        {
            Ok(manager) => manager,
            Err(error) => {
                // 媒体会话不可用时只降级：输出一次错误并保持空转，网络/屏幕监听继续工作。
                eprintln!("媒体会话不可用，已跳过媒体事件监听：{}", error.message());
                while let Ok(msg) = rx.recv() {
                    if matches!(msg, MediaMsg::Shutdown) {
                        break;
                    }
                }
                return;
            }
        };

        let sessions_tx = tx.clone();
        let sessions_handler = TypedEventHandler::new(move |_, _| {
            let _ = sessions_tx.send(MediaMsg::Refresh);
            Ok(())
        });
        let sessions_token = match manager.SessionsChanged(&sessions_handler) {
            Ok(token) => token,
            Err(error) => {
                eprintln!("媒体会话不可用，已跳过媒体事件监听：{}", error.message());
                return;
            }
        };

        let mut sessions: Vec<(GlobalSystemMediaTransportControlsSession, String, i64)> = Vec::new();
        let mut playing: Option<BTreeMap<String, String>> = None;

        Self::refresh(&manager, &tx, &mut sessions, &mut playing);

        while let Ok(msg) = rx.recv() {
            match msg {
                MediaMsg::Refresh => Self::refresh(&manager, &tx, &mut sessions, &mut playing),
                MediaMsg::PlaybackChanged => Self::report_playback(&sessions, &mut playing),
                MediaMsg::Shutdown => break,
            }
        }

        let _ = manager.RemoveSessionsChanged(sessions_token);
        for (session, _, token) in sessions {
            let _ = session.RemovePlaybackInfoChanged(token);
        }
    }

    fn refresh(
        manager: &GlobalSystemMediaTransportControlsSessionManager,
        tx: &mpsc::Sender<MediaMsg>,
        sessions: &mut Vec<(GlobalSystemMediaTransportControlsSession, String, i64)>,
        playing: &mut Option<BTreeMap<String, String>>,
    ) {
        let Ok(list) = manager.GetSessions() else {
            return;
        };
        let mut current = Vec::new();
        for session in list {
            current.push(session);
        }

        // 移除已关闭的会话并取消事件订阅。
        let mut index = 0;
        while index < sessions.len() {
            if current.iter().any(|item| item == &sessions[index].0) {
                index += 1;
            } else {
                let (session, _, token) = sessions.swap_remove(index);
                let _ = session.RemovePlaybackInfoChanged(token);
            }
        }

        // 订阅新出现的会话。
        for session in current {
            if sessions.iter().any(|(existing, _, _)| existing == &session) {
                continue;
            }
            let Ok(app_id) = session.SourceAppUserModelId() else {
                continue;
            };
            let playback_tx = tx.clone();
            let handler = TypedEventHandler::new(move |_, _| {
                let _ = playback_tx.send(MediaMsg::PlaybackChanged);
                Ok(())
            });
            if let Ok(token) = session.PlaybackInfoChanged(&handler) {
                sessions.push((session, app_id.to_string(), token));
            }
        }

        Self::report_playback(sessions, playing);
    }

    fn report_playback(
        sessions: &[(GlobalSystemMediaTransportControlsSession, String, i64)],
        playing: &mut Option<BTreeMap<String, String>>,
    ) {
        let mut current = BTreeMap::new();
        for (session, app_id, _) in sessions {
            let is_playing = session
                .GetPlaybackInfo()
                .and_then(|info| info.PlaybackStatus())
                .map(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                .unwrap_or(false);
            if is_playing {
                current
                    .entry(app_id.to_lowercase())
                    .or_insert_with(|| app_id.clone());
            }
        }

        if let Some(previous) = playing.as_ref() {
            for (key, app_id) in previous {
                if !current.contains_key(key) {
                    publish("stopped", false, Some(app_id));
                }
            }
            for (key, app_id) in &current {
                if !previous.contains_key(key) {
                    publish("playing", true, Some(app_id));
                }
            }
        }

        *playing = Some(current);
    }
}

impl Drop for MediaListener {
    fn drop(&mut self) {
        let _ = self.tx.send(MediaMsg::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct ScreenListener {
    hwnd: HWND,
    registration: HPOWERNOTIFY,
}

impl ScreenListener {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            let module = GetModuleHandleW(None)?;
            let hinstance = HINSTANCE(module.0);
            let class_name = w!("KHooksWindowsEventsScreenWindow");

            let wc = WNDCLASSW {
                lpfnWndProc: Some(Self::wnd_proc),
                hInstance: hinstance,
                lpszClassName: class_name,
                ..Default::default()
            };
            RegisterClassW(&wc);

            // 不能使用 HWND_MESSAGE：电源广播消息 WM_POWERBROADCAST 只发送给顶层窗口。
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                None,
                None,
                Some(hinstance),
                None,
            )?;

            let registration = RegisterPowerSettingNotification(
                HANDLE(hwnd.0),
                &GUID_SESSION_DISPLAY_STATUS,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            )?;

            Ok(Self { hwnd, registration })
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_POWERBROADCAST if wparam.0 == PBT_POWERSETTINGCHANGE as usize && lparam.0 != 0 => {
                let setting = unsafe { &*(lparam.0 as *const POWERBROADCAST_SETTING) };
                if setting.PowerSetting == GUID_SESSION_DISPLAY_STATUS
                    && setting.DataLength >= std::mem::size_of::<u32>() as u32
                {
                    let display_state =
                        unsafe { (setting.Data.as_ptr() as *const u32).read_unaligned() };
                    let state = display_state != 0;
                    let mut changed = None;
                    {
                        let mut guard = SCREEN_STATE.get_or_init(|| Mutex::new(None)).lock().unwrap();
                        if let Some(previous) = *guard
                            && previous != state
                        {
                            changed = Some(state);
                        }
                        *guard = Some(state);
                    }
                    if let Some(current) = changed {
                        publish(
                            if current { "screenOn" } else { "screenOff" },
                            current,
                            None,
                        );
                    }
                }
                LRESULT(1)
            }
            WM_CLOSE => {
                let _ = unsafe { DestroyWindow(hwnd) };
                LRESULT(0)
            }
            WM_DESTROY => {
                unsafe { PostQuitMessage(0) };
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }
}

impl Drop for ScreenListener {
    fn drop(&mut self) {
        unsafe {
            let _ = UnregisterPowerSettingNotification(self.registration);
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{format_event_json, json_escape, utc_now_iso};

    #[test]
    fn escapes_special_json_characters() {
        assert_eq!(json_escape("a\"b\\c\n\t\x01"), "\"a\\\"b\\\\c\\n\\t\\u0001\"");
    }

    #[test]
    fn formats_events_matching_protocol() {
        assert_eq!(
            format_event_json("online", true, None, "2026-11-25T08:00:00.000Z"),
            "{\"event\":\"online\",\"state\":true,\"triggeredAt\":\"2026-11-25T08:00:00.000Z\"}"
        );
        assert_eq!(
            format_event_json(
                "playing",
                true,
                Some("App\\Name\"1"),
                "2026-11-25T08:00:00.000Z"
            ),
            "{\"event\":\"playing\",\"state\":true,\"triggeredAt\":\"2026-11-25T08:00:00.000Z\",\"appId\":\"App\\\\Name\\\"1\"}"
        );
    }

    #[test]
    fn formats_iso8601_utc_timestamp() {
        let ts = utc_now_iso();
        assert_eq!(ts.len(), 24);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }
}
