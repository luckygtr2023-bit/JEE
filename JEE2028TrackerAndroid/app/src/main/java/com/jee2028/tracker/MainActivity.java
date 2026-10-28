package com.jee2028.tracker;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {
    private WebView web;
    private boolean pageReady = false;
    private String pendingOAuthCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageReady = true;
                deliverPendingOAuth();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equals(uri.getScheme()) && uri.getPath() != null && uri.getPath().startsWith("/android_asset/")) return false;
                if ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                }
                return true;
            }
        });
        web.addJavascriptInterface(new WidgetBridge(), "AndroidJeeWidget");
        web.addJavascriptInterface(new AuthBridge(), "AndroidJeeAuth");
        web.loadUrl("file:///android_asset/index.html");
        dispatchOAuth(getIntent());
    }

    public final class WidgetBridge {
        @JavascriptInterface public void saveWidgetData(String data) {
            getSharedPreferences("jee_widget", MODE_PRIVATE).edit().putString("data", data).apply();
            JeeWidgetProvider.updateAll(MainActivity.this);
        }
    }

    public final class AuthBridge {
        private static final String KEY_ALIAS = "jee2028.session.aes";
        private static final String PREFS = "jee_auth_session";

        @JavascriptInterface public boolean saveSession(String value) {
            if (value == null || value.length() > 4096) return false;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, sessionKey());
                byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                        .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply();
                return true;
            } catch (Exception ignored) { return false; }
        }

        @JavascriptInterface public String getSession() {
            try {
                android.content.SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                String iv = prefs.getString("iv", null); String ciphertext = prefs.getString("ciphertext", null);
                if (iv == null || ciphertext == null) return "";
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, sessionKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
                return new String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (Exception ignored) { clearStoredSession(); return ""; }
        }

        @JavascriptInterface public void clearSession() { clearStoredSession(); }

        private SecretKey sessionKey() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
            if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true).build());
            return generator.generateKey();
        }

        private void clearStoredSession() { getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply(); }

        @JavascriptInterface public void openExternal(String value) {
            try {
                Uri uri = Uri.parse(value);
                if (!"https".equalsIgnoreCase(uri.getScheme()) || !"accounts.google.com".equalsIgnoreCase(uri.getHost())) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "Blocked an untrusted sign-in URL", Toast.LENGTH_SHORT).show());
                    return;
                }
                runOnUiThread(() -> startActivity(new Intent(Intent.ACTION_VIEW, uri)));
            } catch (Exception ignored) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Could not open the sign-in page", Toast.LENGTH_SHORT).show());
            }
        }
    }

    private void dispatchOAuth(Intent intent) {
        if (web == null || intent == null) return;
        Uri uri = intent.getData();
        if (uri == null || !"jee2028".equals(uri.getScheme()) || !"oauth".equals(uri.getHost()) || !"/callback".equals(uri.getPath())) return;
        pendingOAuthCallback = uri.toString();
        deliverPendingOAuth();
    }

    private void deliverPendingOAuth() {
        if (!pageReady || pendingOAuthCallback == null || web == null) return;
        String callback = pendingOAuthCallback;
        pendingOAuthCallback = null;
        web.post(() -> web.evaluateJavascript("window.JeeAuth&&window.JeeAuth.handleCallback(" +
                org.json.JSONObject.quote(callback) + ")", null));
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        dispatchOAuth(intent);
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
