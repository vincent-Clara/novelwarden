package io.github.noir017.novelforge;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

/**
 * 內建服務端：Termux 編的 node（jniLibs 裡的 libnode.so，見 scripts/fetch-node.sh）跑 assets/server.cjs
 * ——獨立版打成的 node 單檔案（scripts/build-android-server.js）。
 * Android 10+ 只允許執行 nativeLibraryDir 裡的檔案，所以 node 不能放進資料目錄。
 * 只監聽 127.0.0.1，但手機上任何 app 都能連回環地址（包括 /mcp），所以一律帶每臺裝置隨機生成的令牌。
 */
final class LocalServer {
    static final class Status {
        final String url;
        final String token;
        final boolean ok;
        final String error;

        Status(String url, String token, boolean ok, String error) {
            this.url = url;
            this.token = token;
            this.ok = ok;
            this.error = error;
        }
    }

    private static final String TAG = "NovelForgeServer";
    /** 與獨立版預設埠相同；被佔用才隨機 */
    private static final int PREFERRED_PORT = 36800;
    private static final long START_TIMEOUT_MS = 30_000;

    private final Context ctx;
    private final SharedPreferences prefs;
    private Process proc;
    private Status status;
    private File booksDir;
    /** 最近的輸出，啟動失敗時拿來當原因 */
    private final ArrayDeque<String> tail = new ArrayDeque<>();

    LocalServer(Context ctx, SharedPreferences prefs) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = prefs;
    }

    /** 在跑、而且書的位置沒變 */
    synchronized boolean isRunning(File books) {
        return proc != null && proc.isAlive() && status != null && status.ok && books.equals(booksDir);
    }

    /**
     * 啟動並等到能連上（阻塞，別在主執行緒調）；已在跑、書的位置也沒變就直接返回。
     * @param books 放書的目錄：node 的家目錄，「新建一本書」「開啟資料夾」都從這裡起
     */
    synchronized Status start(File books) {
        if (isRunning(books)) return status;
        stop();
        String token = token();
        int port = pickPort();
        String url = "http://127.0.0.1:" + port;
        try {
            File script = installServer();
            File nativeDir = new File(ctx.getApplicationInfo().nativeLibraryDir);
            File node = new File(nativeDir, "libnode.so");
            if (!node.exists()) return status = new Status(url, token, false, "APK 裡沒有 node（libnode.so）");

            // 目錄名沿用舊名：app 私有目錄裡的配置與 API Key 不能因為改名丟一次。
            File config = new File(ctx.getFilesDir(), "novelforge");
            File tmp = new File(ctx.getCacheDir(), "server-tmp");
            //noinspection ResultOfMethodCallIgnored
            tmp.mkdirs();
            //noinspection ResultOfMethodCallIgnored
            books.mkdirs();

            // --use-bundled-ca：Termux 版 node 預設去 Termux 目錄找根證書，這裡沒有，調模型的 HTTPS 會失敗。
            // node:sqlite 每次開庫都打一行 ExperimentalWarning，只會把日誌刷滿。
            ProcessBuilder pb = new ProcessBuilder(node.getPath(), "--use-bundled-ca", "--disable-warning=ExperimentalWarning",
                    script.getPath(), "--port", String.valueOf(port), "--no-open")
                    .directory(books)
                    .redirectErrorStream(true);
            Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", nativeDir.getPath());
            env.put("HOME", books.getPath());
            // 配置與 API Key 留在 app 私有目錄，別跟著家目錄落到別的 app 也讀得到的地方（src/core/stores.ts）
            env.put("NOVELWARDEN_HOME", config.getPath());
            env.put("NOVELWARDEN_TOKEN", token);
            env.put("TMPDIR", tmp.getPath());
            env.put("TZ", TimeZone.getDefault().getID());
            proc = pb.start();
            booksDir = books;
            pumpOutput(proc.getInputStream());
            return status = waitReady(url, token);
        } catch (IOException e) {
            Log.e(TAG, "start failed", e);
            stop();
            return status = new Status(url, token, false, String.valueOf(e.getMessage()));
        }
    }

    synchronized void stop() {
        status = null;
        booksDir = null;
        if (proc == null) return;
        proc.destroy();
        try {
            if (!proc.waitFor(2, TimeUnit.SECONDS)) proc.destroyForcibly();
        } catch (InterruptedException e) {
            proc.destroyForcibly();
            Thread.currentThread().interrupt();
        }
        proc = null;
    }

    /** 登入頁不要令牌，它回 200 就是服務起來了 */
    private Status waitReady(String url, String token) {
        long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (!proc.isAlive()) return new Status(url, token, false, "node 退出（" + proc.exitValue() + "）：" + lastOutput());
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url + "/login").openConnection();
                c.setConnectTimeout(500);
                c.setReadTimeout(1000);
                int code = c.getResponseCode();
                c.disconnect();
                if (code == 200) return new Status(url, token, true, null);
            } catch (IOException ignored) {
                // 還沒開始監聽
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return new Status(url, token, false, "啟動超時：" + lastOutput());
    }

    private String token() {
        String t = prefs.getString("server_token", null);
        if (t == null) {
            byte[] b = new byte[24];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            t = sb.toString();
            prefs.edit().putString("server_token", t).apply();
        }
        return t;
    }

    private static int pickPort() {
        try (ServerSocket s = new ServerSocket(PREFERRED_PORT, 1, InetAddress.getByName("127.0.0.1"))) {
            return s.getLocalPort();
        } catch (IOException e) {
            try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
                return s.getLocalPort();
            } catch (IOException e2) {
                return PREFERRED_PORT;
            }
        }
    }

    /** 把 assets/server.cjs 拷到 files/server/；APK 沒更新過就沿用上次拷好的 */
    private File installServer() throws IOException {
        File dir = new File(ctx.getFilesDir(), "server");
        File script = new File(dir, "server.cjs");
        long stamp;
        try {
            stamp = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            stamp = -1;
        }
        if (script.isFile() && prefs.getLong("server_stamp", 0) == stamp) return script;
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File part = new File(dir, "server.cjs.part");
        byte[] buf = new byte[64 * 1024];
        try (InputStream in = ctx.getAssets().open("server.cjs"); OutputStream out = new FileOutputStream(part)) {
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
        if (!part.renameTo(script)) throw new IOException("寫不進 " + script);
        prefs.edit().putLong("server_stamp", stamp).apply();
        return script;
    }

    /** node 的輸出進 logcat 和 files/server.log（覆蓋寫，只留本次執行） */
    private void pumpOutput(InputStream in) {
        File log = new File(ctx.getFilesDir(), "server.log");
        synchronized (tail) {
            tail.clear();
        }
        Thread t = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                 PrintWriter w = new PrintWriter(new FileOutputStream(log), true)) {
                for (String line; (line = r.readLine()) != null; ) {
                    Log.i(TAG, line);
                    w.println(line);
                    synchronized (tail) {
                        tail.addLast(line);
                        if (tail.size() > 5) tail.removeFirst();
                    }
                }
            } catch (IOException ignored) {
                // 程序結束
            }
        }, "server-log");
        t.setDaemon(true);
        t.start();
    }

    private String lastOutput() {
        synchronized (tail) {
            return tail.isEmpty() ? "無輸出" : String.join(" / ", tail);
        }
    }
}
