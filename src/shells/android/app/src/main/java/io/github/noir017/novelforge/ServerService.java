package io.github.noir017.novelforge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 本機模式的前臺服務：只為掛一條常駐通知。寫一章要跑幾分鐘，切到別的 app 時系統會把後臺 app 連同它起的 node
 * 一起凍住（Android 11+ 的 cached apps freezer），模型的流斷在半路；有前臺服務的 app 不算後臺，node 接著跑。
 * node 程序本身歸 {@link LocalServer} 管，這裡不碰它，只在作者把 app 從最近任務裡劃掉時一起收掉。
 */
public class ServerService extends Service {
    private static final String CHANNEL = "server";
    private static final int NOTIFICATION_ID = 1;

    static void start(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, ServerService.class));
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, ServerService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "本機服務", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_edit)
                .setContentTitle("Novelwarden 本機服務在執行")
                .setContentText("切到別的 app 時，正在寫的章節不會斷")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, n);
        // 被系統殺了不自己重啟：服務端由 Activity 起，重啟的服務手裡沒有它
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        MainActivity.shutdownServer();
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
