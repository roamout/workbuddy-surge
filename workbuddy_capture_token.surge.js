/**
 * WorkBuddy 令牌捕获脚本 —— Surge 重写脚本（一次性使用）
 *
 * 作用：
 *   在手机上正常登录 / 使用 WorkBuddy App 或微信小程序时，自动拦截登录、
 *   令牌刷新请求，把长效令牌 refresh_token 抓取下来写入 Surge 持久化存储，
 *   供 workbuddy_checkin.surge.js 每日签到使用。
 *
 * 提取方式（双保险）：
 *   1. 精确提取：响应 JSON 里的 refreshToken / refresh_token 字段
 *   2. 特征扫描：在任意 JSON 中寻找 typ=Offline 的 JWT（长效令牌的强特征）
 *
 * 通知策略：
 *   只在“首次捕获”或“令牌发生轮换更新”时弹一次通知；令牌没有变化时
 *   完全静默，不重复打扰。
 *
 * 用法建议：
 *   看到“捕获成功”通知后，即可在 Surge 中停用或删除本重写。忘记关闭也没关系：
 *   脚本只读取令牌、不发起任何请求，会在 App 令牌轮换时自动同步最新值。
 *
 * 与 QX 版的差异：
 *   - 持久化存储：$persistentStore（Surge）替代 $prefs（QX）
 *   - 通知：$notification.post（Surge）替代 $notify（QX）
 *   - 两者共用同一把 key：workbuddy_checkin_rt
 *
 * 部署（完整模块见 workbuddy.sgmodule）
 */

const VERSION = "v1.1.0-surge";

// 与签到脚本共用同一把 key
const PREF_KEY_RT = "workbuddy_checkin_rt";

// ============ 工具函数 ============
function isJwt(v) {
  return typeof v === "string"
    && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)
    && v.length > 100;
}

// 解 JWT payload（用于识别 Offline 长效令牌）
function decodeJwtPayload(token) {
  try {
    let p = token.split(".")[1];
    if (!p) return null;
    p = p.replace(/-/g, "+").replace(/_/g, "/");
    while (p.length % 4) p += "=";
    const raw = (typeof atob === "function")
      ? atob(p)
      : (function () {
          // 无 atob 时的兜底解码
          const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
          let out = "";
          for (let i = 0; i < p.length; i += 4) {
            const n = (chars.indexOf(p[i]) << 18) | (chars.indexOf(p[i + 1]) << 12)
              | ((p[i + 2] ? chars.indexOf(p[i + 2]) : 0) << 6)
              | (p[i + 3] ? chars.indexOf(p[i + 3]) : 0);
            out += String.fromCharCode((n >> 16) & 255, (n >> 8) & 255, n & 255);
          }
          return out;
        })();
    const json = decodeURIComponent(escape(raw));
    return JSON.parse(json);
  } catch (e) { return null; }
}

// 是否为长效（Offline / refresh）令牌
function isOfflineToken(token) {
  if (!isJwt(token)) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (payload.typ && /offline/i.test(String(payload.typ))) return true;
  if (payload.scope && /offline_access/.test(payload.scope)
      && !(payload.token_type && /bearer/i.test(String(payload.token_type)))) return true;
  return false;
}

function walkStrings(obj, depth, fn) {
  if (depth > 8 || obj === null || obj === undefined) return;
  if (typeof obj === "string") { fn(obj); return; }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walkStrings(obj[i], depth + 1, fn);
    return;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) walkStrings(obj[keys[i]], depth + 1, fn);
  }
}

// 精确字段提取
function findByFieldName(obj, depth) {
  if (depth > 8 || obj === null || obj === undefined) return null;
  if (typeof obj === "string") return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = findByFieldName(obj[i], depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i].toLowerCase();
      const v = obj[keys[i]];
      if (typeof v === "string"
          && (k === "refreshtoken" || k === "refresh_token" || k === "refresh_token_str")) {
        if (isJwt(v)) return v;
      }
    }
    for (let i = 0; i < keys.length; i++) {
      const hit = findByFieldName(obj[keys[i]], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

// 特征扫描：找 typ=Offline 的 JWT
function findByOfflineFeature(obj) {
  let found = null;
  walkStrings(obj, 0, function (s) {
    if (found) return;
    if (isOfflineToken(s)) found = s;
  });
  return found;
}

// 大小写不敏感读取请求头
function getHeaderCI(headers, name) {
  if (!headers) return null;
  const target = String(name).toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === target) return headers[keys[i]];
  }
  return null;
}

// Surge 持久化存储读取
function prefGet(key) {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore
        && $persistentStore.read) {
      return $persistentStore.read(key);
    }
  } catch (e) {}
  return null;
}

// Surge 持久化存储写入
function prefSet(key, value) {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore
        && $persistentStore.write) {
      return $persistentStore.write(value, key);
    }
  } catch (e) {}
  return false;
}

// Surge 通知
function notify(title, subtitle, body) {
  try {
    if (typeof $notification !== "undefined" && $notification
        && $notification.post) {
      $notification.post(title, subtitle, body);
    }
  } catch (e) {}
}

function safeParse(body) {
  if (!body) return null;
  if (typeof body === "object") return body;
  if (body.length > 2000000) return null;   // 超大响应（流式/文件）不处理
  try { return JSON.parse(body); } catch (e) { return null; }
}

// 诊断探针：响应含 refresh 字样但没提取到时，留一条日志便于排查
function logProbe(url, rawBody) {
  try {
    if (typeof rawBody !== "string" || rawBody.length === 0) return;
    if (/refresh/i.test(rawBody)) {
      const hasJwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(rawBody);
      console.log("[WorkBuddyCapture] probe " + url + " hasRefreshText jwt=" + hasJwt + " len=" + rawBody.length);
    }
  } catch (e) {}
}

// ============ 核心：保存令牌 ============
function saveToken(rt, source) {
  if (!isJwt(rt)) return false;

  const old = prefGet(PREF_KEY_RT);
  if (old === rt) return true;   // 同一个令牌，不重复通知

  prefSet(PREF_KEY_RT, rt);
  console.log("[WorkBuddyCapture] refresh token saved from " + source);

  if (!old) {
    notify(
      "✅ WorkBuddy 令牌捕获成功",
      "签到脚本已就绪，建议关闭本重写",
      "长效令牌已自动保存（来源：" + source + "）。\n"
      + "现在可以回 Surge「模块」停用或删除 WorkBuddy 捕获规则，只保留每日签到定时任务。\n"
      + "忘记关闭也没关系：脚本只读取令牌，App 轮换时会自动同步最新值。"
    );
  } else {
    notify(
      "🔄 WorkBuddy 令牌已自动更新",
      "检测到令牌轮换，已同步最新值",
      "来源：" + source + "。签到脚本将继续使用最新令牌。"
    );
  }
  return true;
}

// ============ 入口：同时兼容请求头 / 响应体两种绑定 ============
(function () {
  try {
    const reqUrl = (typeof $request !== "undefined" && $request && $request.url) ? $request.url : "";

    // —— 响应体阶段 ——
    if (typeof $response !== "undefined" && $response) {
      const json = safeParse($response.body);
      if (json) {
        // 先精确字段，再 Offline 特征兜底
        const rt = findByFieldName(json, 0) || findByOfflineFeature(json);
        if (rt) { saveToken(rt, "响应体"); $done({}); return; }
      }
      logProbe(reqUrl, $response.body);
      $done({});
      return;
    }

    // —— 请求头阶段：刷新接口 X-Refresh-Token ——
    if (typeof $request !== "undefined" && $request) {
      const rt = getHeaderCI($request.headers, "X-Refresh-Token");
      if (rt && isJwt(rt)) { saveToken(rt, "刷新请求头"); $done({}); return; }
      $done({});
      return;
    }

    $done({});
  } catch (e) {
    console.log("[WorkBuddyCapture] error: " + (e && e.message ? e.message : e));
    $done({});
  }
})();
