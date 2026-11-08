package io.github.noir017.novelforge;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONTokener;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * WebView 殼。頁面由服務端吐出來（獨立版的同一個頁面），殼只決定開啟哪個地址：
 * - 本機模式（預設）：起內建服務端（{@link LocalServer}），帶令牌登入後開啟 http://127.0.0.1:端口；
 * - 遠端模式：開啟設定裡填的伺服器地址（比如部署在 NAS 上的 Docker 版），有令牌就替作者登入
 *   （設定裡填的，或在網頁登入頁上輸對過一次的）。
 * 服務端設定是原生對話方塊：頁面屬於服務端，遠端那臺的版本不一定認識這個殼。入口是返回鍵彈出的選單，
 * 連不上時的提示頁上也有。
 */
public class MainActivity extends Activity {
    private static final String TAG = "NovelForge";
    private static final int REQ_STORAGE = 1;
    private static final int REQ_NOTIFY = 2;

    /** 程序級：Activity 重建不重啟服務端 */
    private static LocalServer server;
    private static final ExecutorService bg = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs;
    private WebView web;
    private LinearLayout panel;
    private TextView panelText;
    private LinearLayout panelButtons;
    /** 當前服務端的源（scheme://host:port）：同源的連結留在 WebView 裡，別的交給瀏覽器 */
    private Uri base;
    private boolean starting;
    private boolean loadFailed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("novelforge", MODE_PRIVATE);
        if (server == null) server = new LocalServer(this, prefs);

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web);
        root.addView(buildPanel());
        setContentView(root);
        // 頁面沒載入出來前先用上次的顏色，免得深色主題每次啟動都先閃一下白條
        if (prefs.contains("bar_color")) applyBarColor(prefs.getInt("bar_color", 0));
        setupWebView();
        boot();
    }

    private View buildPanel() {
        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        int pad = dp(32);
        panel.setPadding(pad, pad, pad, pad);
        TypedValue bgColor = new TypedValue();
        getTheme().resolveAttribute(android.R.attr.colorBackground, bgColor, true);
        panel.setBackgroundColor(bgColor.data);
        panelText = new TextView(this);
        panelText.setGravity(Gravity.CENTER);
        panelText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        panel.addView(panelText);
        panelButtons = new LinearLayout(this);
        panelButtons.setGravity(Gravity.CENTER);
        panelButtons.setPadding(0, dp(16), 0, 0);
        Button retry = new Button(this);
        retry.setText("重試");
        retry.setOnClickListener(v -> boot());
        Button settings = new Button(this);
        settings.setText("服務端設定");
        settings.setOnClickListener(v -> showServerSettings());
        panelButtons.addView(retry);
        panelButtons.addView(settings);
        panel.addView(panelButtons);
        return panel;
    }

    private void showPanel(String text, boolean withButtons) {
        panelText.setText(text);
        panelButtons.setVisibility(withButtons ? View.VISIBLE : View.GONE);
        panel.setVisibility(View.VISIBLE);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // 字號由頁面自己的設定管，不跟系統字型縮放（放大了窄屏佈局會擠壞）
        s.setTextZoom(100);
        web.addJavascriptInterface(new ShellBridge(), "NovelForgeShell");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (sameOrigin(u)) return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                loadFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadFailed && !starting) panel.setVisibility(View.GONE);
                if (!sameOrigin(Uri.parse(url))) return;
                view.evaluateJavascript(THEME_HOOK, null);
                if ("remote".equals(mode())) rememberWebLogin();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                loadFailed = true;
                showPanel("連不上 " + base + "\n" + err.getDescription(), true);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            /** window.open（外部連結）：交給系統瀏覽器 */
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView probe = new WebView(MainActivity.this);
                probe.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        openExternal(req.getUrl());
                        v.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
    }

    /** "local" / "remote"；預設本機，遠端要在服務端設定裡切 */
    private String mode() {
        return prefs.getString("mode", "local");
    }

    /** 按當前模式啟停內建服務端，再開啟對應的地址 */
    private void boot() {
        if ("remote".equals(mode())) {
            starting = false;
            bg.execute(server::stop);
            ServerService.stop(this);
            String url = prefs.getString("remote_url", "");
            if (url.isEmpty()) {
                showServerSettings();
                return;
            }
            Uri u = Uri.parse(url);
            base = new Uri.Builder().scheme(u.getScheme()).encodedAuthority(u.getEncodedAuthority()).build();
            String token = prefs.getString("remote_token", "");
            // 地址不通時 WebView 要等半分鐘才報錯，這期間也得能改地址
            showPanel("正在連線 " + base + "…", true);
            if (token.isEmpty()) web.loadUrl(base + "/");
            else login(token);
            return;
        }
        if (!publicStorageGranted() && !prefs.getBoolean("storage_asked", false)) {
            askStorage();
            return;
        }
        askNotificationsOnce();
        starting = true;
        showPanel("正在啟動本機服務…", false);
        ServerService.start(this);
        File books = booksDir();
        bg.execute(() -> {
            LocalServer.Status st = server.start(books);
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                starting = false;
                if (!st.ok) {
                    ServerService.stop(this);
                    showPanel("本機服務沒有啟動：" + st.error, true);
                    return;
                }
                base = Uri.parse(st.url);
                login(st.token);
            });
        });
    }

    /** 走服務端自己的登入頁：交令牌、種 cookie、跳回首頁（首頁再跳到最近開啟的那本書） */
    private void login(String token) {
        String form = "token=" + Uri.encode(token) + "&next=%2F";
        web.postUrl(base + "/login", form.getBytes(StandardCharsets.UTF_8));
    }

    private boolean sameOrigin(Uri u) {
        return base != null && base.getScheme() != null && base.getScheme().equals(u.getScheme())
                && base.getEncodedAuthority() != null && base.getEncodedAuthority().equals(u.getEncodedAuthority());
    }

    /**
     * 交登入表單時把令牌放進 sessionStorage；下一頁不再是登入頁（登入成了）就取出來交給殼，
     * 還是登入頁（令牌不對）就扔掉。返回值：取出來的令牌，沒有就是 null
     */
    private static final String LOGIN_HOOK = "(function () {"
            + "var k = 'nfShellToken', f = document.querySelector('form[action=\"/login\"]');"
            + "if (f) {"
            + "  sessionStorage.removeItem(k);"
            + "  f.addEventListener('submit', function () {"
            + "    sessionStorage.setItem(k, f.querySelector('input[name=\"token\"]').value);"
            + "  });"
            + "  return null;"
            + "}"
            + "var t = sessionStorage.getItem(k);"
            + "sessionStorage.removeItem(k);"
            + "return t;"
            + "})()";

    /**
     * 遠端模式下在網頁登入頁上輸的令牌也記下來，之後與設定裡填的一樣每次替作者登入（cookie 只管 30 天）。
     * 不用 addJavascriptInterface：那個對頁面裡的任何 iframe 都敞著；sessionStorage 只有服務端自己的源讀寫得到
     */
    private void rememberWebLogin() {
        web.evaluateJavascript(LOGIN_HOOK, v -> {
            try {
                Object t = new JSONTokener(v).nextValue();
                if (t instanceof String && !((String) t).isEmpty()) {
                    prefs.edit().putString("remote_token", (String) t).apply();
                }
            } catch (JSONException ignored) {
                // 頁面沒跑完指令碼（比如已經跳走了）：這次不記
            }
        });
    }

    // ── 系統欄跟頁面主題 ───────────────────────────────────────────

    /**
     * 盯住頁面的 `<meta name="theme-color">`（換主題時頁面改它，見 media/src/editor/shell.ts 的 syncThemeColor），
     * 一變就交給殼染系統欄。沒有這個 meta 的舊版服務端：什麼都不做，系統欄照舊跟系統深淺色
     */
    private static final String THEME_HOOK = "(function () {"
            + "var m = document.querySelector('meta[name=\"theme-color\"]');"
            + "if (!m || m.dataset.nfShell) return;"
            + "m.dataset.nfShell = '1';"
            + "var send = function () { NovelForgeShell.setBarColor(m.content); };"
            + "new MutationObserver(send).observe(m, { attributes: true, attributeFilter: ['content'] });"
            + "send();"
            + "})()";

    /** 給頁面開的唯一一個口子。頁面裡誰調了都只是換個顏色，所以不必像記令牌那樣躲開 addJavascriptInterface */
    private class ShellBridge {
        @JavascriptInterface
        public void setBarColor(String css) {
            if (css == null) return;
            int color;
            try {
                color = Color.parseColor(css.trim());
            } catch (IllegalArgumentException e) {
                return;
            }
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                prefs.edit().putInt("bar_color", color).apply();
                applyBarColor(color);
            });
        }
    }

    /** 狀態列、導航欄染成頁面標題欄 / 底欄的顏色（兩者同色）；底色淺就換深色圖示 */
    @SuppressWarnings("deprecation")
    private void applyBarColor(int color) {
        Window w = getWindow();
        w.setStatusBarColor(color);
        w.setNavigationBarColor(color);
        boolean light = Color.luminance(color) > 0.5f;
        View decor = w.getDecorView();
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        decor.setSystemUiVisibility(light ? decor.getSystemUiVisibility() | flags : decor.getSystemUiVisibility() & ~flags);
        // Android 11 起只設舊標誌位不一定生效（主題裡的 windowLightStatusBar 會蓋回去），兩樣都設，與 androidx 的做法一致
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            int appearance = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (c != null) c.setSystemBarsAppearance(light ? appearance : 0, appearance);
        }
    }

    // ── 書放在哪 ──────────────────────────────────────────────────

    private boolean publicStorageGranted() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    /** 有許可權放 Documents/NovelForge，沒有就放 app 自己的目錄（解除安裝時一起刪） */
    private File booksDir() {
        if (publicStorageGranted()) {
            return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "NovelForge");
        }
        File own = getExternalFilesDir("books");
        return own != null ? own : new File(getFilesDir(), "books");
    }

    private void askStorage() {
        new AlertDialog.Builder(this)
                .setTitle("書放在哪")
                .setMessage("建議放在「Documents/NovelForge」：檔案管理器、同步盤都看得到，解除安裝 app 也不會刪。"
                        + "這需要「所有檔案訪問」許可權。\n\n不授權就放在 app 自己的目錄，解除安裝 app 時會一起刪掉。之後可以在「服務端設定」裡改。")
                .setPositiveButton("去授權", (d, w) -> {
                    prefs.edit().putBoolean("storage_asked", true).apply();
                    requestStorage();
                })
                .setNegativeButton("放在 app 目錄", (d, w) -> {
                    prefs.edit().putBoolean("storage_asked", true).apply();
                    boot();
                })
                .setCancelable(false)
                .show();
    }

    private void requestStorage() {
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:" + getPackageName())), REQ_STORAGE);
            } catch (ActivityNotFoundException e) {
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), REQ_STORAGE);
            }
        } else {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
        }
    }

    /** 常駐通知要通知許可權（Android 13+）；不給服務照樣跑，只是看不到那條通知，所以只問一次 */
    private void askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33 || prefs.getBoolean("notify_asked", false)) return;
        prefs.edit().putBoolean("notify_asked", true).apply();
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_STORAGE) boot();
        else super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_STORAGE) boot();
    }

    // ── 服務端設定 ─────────────────────────────────────────────────

    private void showServerSettings() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        form.setPadding(pad, dp(8), pad, 0);

        RadioGroup modes = new RadioGroup(this);
        RadioButton local = new RadioButton(this);
        local.setId(View.generateViewId());
        local.setText("本機：在手機上跑內建服務");
        RadioButton remote = new RadioButton(this);
        remote.setId(View.generateViewId());
        remote.setText("遠端：連線已經部署好的伺服器");
        modes.addView(local);
        modes.addView(remote);
        form.addView(modes);

        TextView where = new TextView(this);
        where.setPadding(dp(32), 0, 0, dp(8));
        form.addView(where);
        Button grant = new Button(this);
        grant.setText("改放 Documents/NovelForge（授權）");
        grant.setAllCaps(false);
        grant.setOnClickListener(v -> requestStorage());
        form.addView(grant, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText url = new EditText(this);
        url.setHint("地址，如 192.168.1.10:3680");
        url.setSingleLine(true);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(prefs.getString("remote_url", ""));
        form.addView(url);
        EditText token = new EditText(this);
        token.setHint("訪問令牌（空著就在網頁上輸，輸對一次就記住）");
        // setSingleLine 會換掉遮擋字元的 TransformationMethod，必須排在設密碼型別之前，不然令牌明文顯示
        token.setSingleLine(true);
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setText(prefs.getString("remote_token", ""));
        form.addView(token);

        Runnable sync = () -> {
            boolean isLocal = modes.getCheckedRadioButtonId() == local.getId();
            where.setVisibility(isLocal ? View.VISIBLE : View.GONE);
            where.setText("書放在：" + booksDir());
            grant.setVisibility(isLocal && !publicStorageGranted() ? View.VISIBLE : View.GONE);
            url.setVisibility(isLocal ? View.GONE : View.VISIBLE);
            token.setVisibility(isLocal ? View.GONE : View.VISIBLE);
        };
        modes.check("remote".equals(mode()) ? remote.getId() : local.getId());
        modes.setOnCheckedChangeListener((g, id) -> sync.run());
        sync.run();

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("服務端")
                .setView(form)
                .setPositiveButton("確定", null)
                .setNegativeButton("取消", null)
                .show();
        // 自己接「確定」：地址不對時不關對話方塊
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            boolean isLocal = modes.getCheckedRadioButtonId() == local.getId();
            SharedPreferences.Editor e = prefs.edit().putString("mode", isLocal ? "local" : "remote");
            if (!isLocal) {
                String normalized = normalizeUrl(url.getText().toString());
                if (normalized == null) {
                    url.setError("填伺服器的地址，如 http://192.168.1.10:3680");
                    return;
                }
                e.putString("remote_url", normalized).putString("remote_token", token.getText().toString().trim());
            }
            e.apply();
            dialog.dismiss();
            boot();
        });
    }

    /** 補上 http://、去掉路径：服务端的页面、/ws、/login 都掛在根上 */
    static String normalizeUrl(String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "http://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme();
        if (u.getHost() == null || u.getHost().isEmpty() || !("http".equals(scheme) || "https".equals(scheme))) return null;
        return scheme + "://" + u.getEncodedAuthority();
    }

    // ── 返回鍵與生命週期 ───────────────────────────────────────────

    /**
     * 返回鍵先交給頁面一層層收（選單、彈窗、蓋在側欄上的編輯區，見 media/src/view/mobileNav.ts 的 nfBack）；
     * 頁面說沒什麼可收了（或者頁面還沒載入、開著的是連不上的提示），才彈殼的選單
     */
    @Override
    public void onBackPressed() {
        // 提示頁蓋著網頁（啟動中、連不上）：底下那一頁不是作者看得見的，不去收它的層
        if (panel.getVisibility() == View.VISIBLE) {
            showShellMenu();
            return;
        }
        web.evaluateJavascript("typeof window.nfBack === 'function' && window.nfBack() === true", handled -> {
            if (!"true".equals(handled)) showShellMenu();
        });
    }

    private void showShellMenu() {
        new AlertDialog.Builder(this)
                .setItems(new CharSequence[]{"服務端設定…", "退出 Novelwarden"}, (d, which) -> {
                    if (which == 0) showServerSettings();
                    else quit();
                })
                .show();
    }

    private void quit() {
        shutdownServer();
        ServerService.stop(this);
        finishAndRemoveTask();
    }

    /** 本機服務程序意外退出了（或書的位置變了）：回到前臺時重新起 */
    @Override
    protected void onResume() {
        super.onResume();
        if ("local".equals(mode()) && base != null && !starting && !server.isRunning(booksDir())) boot();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    static void shutdownServer() {
        if (server != null) bg.execute(server::stop);
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            shutdownServer();
            ServerService.stop(this);
        }
        web.destroy();
        super.onDestroy();
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, u.toString(), Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
