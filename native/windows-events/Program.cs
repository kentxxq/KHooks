using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Windows.Media.Control;
using Windows.Networking.Connectivity;

internal static class Program
{
    private static readonly object OutputLock = new();
    private static readonly object NetworkLock = new();
    private static bool? online;

    [STAThread]
    private static void Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        using var screen = new ScreenListener();
        using var media = new MediaListener();
        NetworkInformation.NetworkStatusChanged += OnNetworkChanged;
        OnNetworkChanged(null);
        _ = media.StartAsync();
        _ = Task.Run(async () =>
        {
            while (await Console.In.ReadLineAsync() is not null) { }
            Environment.Exit(0);
        });
        try { Application.Run(); }
        finally { NetworkInformation.NetworkStatusChanged -= OnNetworkChanged; }
    }

    private static void OnNetworkChanged(object? sender)
    {
        lock (NetworkLock)
        {
            var state = NetworkInformation.GetInternetConnectionProfile()?.GetNetworkConnectivityLevel()
                == NetworkConnectivityLevel.InternetAccess;
            if (online is not null && online != state) Publish(state ? "online" : "offline", state);
            online = state;
        }
    }

    private static void Publish(string kind, bool state, string? source = null)
    {
        var payload = new Dictionary<string, object>
        {
            ["event"] = kind, ["state"] = state, ["triggeredAt"] = DateTime.UtcNow.ToString("O")
        };
        if (source is not null) payload["appId"] = source;
        lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(payload));
    }

    private sealed class MediaListener : IDisposable
    {
        private readonly object sync = new();
        private GlobalSystemMediaTransportControlsSessionManager? manager;
        private readonly Dictionary<GlobalSystemMediaTransportControlsSession, string> sessions = new();
        private HashSet<string>? playing;
        private bool disposed;

        public async Task StartAsync()
        {
            try
            {
                var current = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                lock (sync)
                {
                    if (disposed) return;
                    manager = current;
                    manager.SessionsChanged += OnSessionsChanged;
                    Refresh();
                }
            }
            catch (Exception error)
            {
                // 媒体会话不可用时只降级:输出一次错误并保持空转,网络/屏幕监听继续工作。
                Console.Error.WriteLine("媒体会话不可用，已跳过媒体事件监听：" + error.Message);
            }
        }

        private void OnSessionsChanged(GlobalSystemMediaTransportControlsSessionManager sender, SessionsChangedEventArgs args)
        {
            lock (sync)
            {
                if (!disposed) Refresh();
            }
        }

        private void OnPlaybackChanged(GlobalSystemMediaTransportControlsSession sender, PlaybackInfoChangedEventArgs args)
        {
            lock (sync)
            {
                if (!disposed) ReportPlayback();
            }
        }

        private void Refresh()
        {
            var current = manager!.GetSessions().ToHashSet();
            foreach (var session in sessions.Keys.Where(session => !current.Contains(session)).ToArray())
            {
                session.PlaybackInfoChanged -= OnPlaybackChanged;
                sessions.Remove(session);
            }
            foreach (var session in current.Where(session => !sessions.ContainsKey(session)))
            {
                sessions.Add(session, session.SourceAppUserModelId);
                session.PlaybackInfoChanged += OnPlaybackChanged;
            }
            ReportPlayback();
        }

        private void ReportPlayback()
        {
            var current = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var (session, appId) in sessions)
            {
                try
                {
                    if (session.GetPlaybackInfo()?.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                        current.Add(appId);
                }
                catch (COMException) { /* 会话关闭后，等待会话列表更新。 */ }
            }
            if (playing is not null)
            {
                foreach (var appId in playing.Except(current, current.Comparer)) Publish("stopped", false, appId);
                foreach (var appId in current.Except(playing, current.Comparer)) Publish("playing", true, appId);
            }
            playing = current;
        }

        public void Dispose()
        {
            lock (sync)
            {
                disposed = true;
                if (manager is not null) manager.SessionsChanged -= OnSessionsChanged;
                foreach (var session in sessions.Keys) session.PlaybackInfoChanged -= OnPlaybackChanged;
                sessions.Clear();
            }
        }
    }

    private sealed class ScreenListener : NativeWindow, IDisposable
    {
        private static readonly Guid SessionDisplayStatus = new("2B84C20E-AD23-4DDF-93DB-05FFBD7EFCA5");
        private const int PowerBroadcast = 0x0218;
        private const int PowerSettingChange = 0x8013;
        private readonly IntPtr registration;
        private bool? screenOn;

        public ScreenListener()
        {
            CreateHandle(new CreateParams());
            registration = RegisterPowerSettingNotification(Handle, SessionDisplayStatus, 0);
            if (registration == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == PowerBroadcast && message.WParam.ToInt64() == PowerSettingChange &&
                message.LParam != IntPtr.Zero && Marshal.PtrToStructure<Guid>(message.LParam) == SessionDisplayStatus &&
                Marshal.ReadInt32(message.LParam, 16) >= sizeof(int))
            {
                var displayState = Marshal.ReadInt32(message.LParam, 20);
                var state = displayState != 0;
                if (screenOn is not null && screenOn != state) Publish(state ? "screenOn" : "screenOff", state);
                screenOn = state;
            }
            base.WndProc(ref message);
        }

        public void Dispose()
        {
            UnregisterPowerSettingNotification(registration);
            DestroyHandle();
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr RegisterPowerSettingNotification(IntPtr recipient, in Guid setting, int flags);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnregisterPowerSettingNotification(IntPtr registration);
    }
}
