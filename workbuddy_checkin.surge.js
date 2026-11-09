/**
 * WorkBuddy 每日自动签到 —— Surge 定时任务脚本
 *
 * 版本：v1.0.1-surge
 * 功能：
 *   1. 用长效令牌(refresh token)换新的接口令牌(accessToken)
 *   2. 查询签到状态，未签则领取(每日 +100 积分，第 7 天 +1000)
 *   3. 派猫猫旅行闭环：先领到达奖励，再派出 Buddy
 *   4. 在签到/旅行奖励全部完成后，调用账户资源接口查询【真实可用积分余额】
 *   5. 自动把轮换出的新 refresh token 回写 Surge $persistentStore，实现长期自续
 *   6. 通过 $notification.post 弹通知播报结果（含真实账户余额）
 *
 * 余额说明：
 *   签到状态接口(checkin-activity-status)里的 total_credits 只是“签到活动赛季
 *   周期累计/满额”，并非账户可用余额，不能当作余额显示。
 *   真实账户余额取自 get-user-resource-summary 的 data.TotalCredits（各资源包
 *   剩余可用积分之和），且在所有领取动作完成后再查，保证是到账后的最新值。
 *
 * 与 QX 版的差异：
 *   - HTTP：$httpClient（Surge）替代 $task.fetch（QX）
 *   - 持久化：$persistentStore（Surge）替代 $prefs（QX）
 *   - 通知：$notification.post（Surge）替代 $notify（QX）
 *   - 其余逻辑完全一致，接口与字段名均未变
 *
 * 部署（Cron，每天 09:03，避开整点，见 workbuddy.sgmodule）：
 *   cron "3 9 * * *" script-path=..., tag=WorkBuddy签到
 *
 * 令牌从哪来（二选一）：
 *   方式一（推荐）：安装 workbuddy.sgmodule 捕获重写，打开 WorkBuddy App /
 *     小程序登录一次，令牌自动写入持久化存储，本脚本直接读取，无需编辑文件。
 *   方式二（手动）：把下方 MANUAL_REFRESH_TOKEN 常量填为你的长效令牌。
 *   读取优先级：Surge 持久化存储(workbuddy_checkin_rt) > 顶部 MANUAL_REFRESH_TOKEN。
 *
 * 令牌失效场景：在 WorkBuddy 客户端退出账号、或连续 60 天以上没有成功运行，
 *   重新开一次捕获重写、登录一次即可恢复。
 */

const VERSION = "v1.0.1-surge";

// ============ 手动配置（可选，推荐用捕获重写自动获取，此处留空） ============
const MANUAL_REFRESH_TOKEN = "";

// ============ 接口常量（勿改） ============
const REFRESH_URL = "https://copilot.tencent.com/v2/plugin/auth/token/refresh";
const CHECKIN_DOMAIN = "https://www.codebuddy.cn";
const STATUS_URL = CHECKIN_DOMAIN + "/v2/billing/meter/checkin-activity-status";
const CHECKIN_URL = CHECKIN_DOMAIN + "/v2/billing/meter/daily-checkin";
// 账户真实可用积分余额（注意：该接口路径没有 /v2 前缀）
const BALANCE_URL = CHECKIN_DOMAIN + "/billing/meter/get-user-resource-summary";
const TRAVEL_DOMAIN = "https://www.workbuddy.cn";
const TRAVEL_STATUS_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/status";
const TRAVEL_CLAIM_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/claim";
const TRAVEL_DEPART_URL = TRAVEL_DOMAIN + "/activity/growth/buddy/travel/depart";

const PREF_KEY_RT = "workbuddy_checkin_rt";

let _newRt = "";   // 刷新后轮换出的新 refresh token（用于回写）
const result = {
  refreshed: false,
  checkin: "",
  balance: null,      // 真实账户可用积分余额（领取后查询，来自 get-user-resource-summary）
  dailyCredit: null,  // 今日签到可领取的积分（来自签到状态，如 100 / 第7天 1000）
  streak: null,
  travel: "",
  gained: false,      // 本次是否实际发生了签到/旅行奖励到账（决定查余额前是否等待）
  error: null
};

// ============ 工具：持久化存储读写（Surge $persistentStore） ============
function getRt() {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore
        && $persistentStore.read) {
      const v = $persistentStore.read(PREF_KEY_RT);
      if (v && v.length > 20) return v;
    }
  } catch (e) {}
  return MANUAL_REFRESH_TOKEN;
}

function saveRt(rt) {
  if (!rt || rt.length < 20) return;
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore
        && $persistentStore.write) {
      $persistentStore.write(rt, PREF_KEY_RT);
    }
  } catch (e) {}
}

// ============ 工具：HTTP 请求（Surge $httpClient，返回 Promise） ============
function httpRequest(url, method, headers, body) {
  return new Promise(function (resolve, reject) {
    const opts = {
      url: url,
      method: method,
      headers: headers,
      body: body,
      // Surge 默认跟随重定向；不校验证书关闭（与 QX skip-cert-verify:false 对应）
      // 需要时可手动加 opts.opts = { insecure: true }
    };
    $httpClient[method.toLowerCase() === "post" ? "post" : "get"](opts, function (error, response, data) {
      if (error) {
        reject(new Error("HTTP 请求失败: " + error));
        return;
      }
      resolve({ status: response.status, headers: response.headers, body: data });
    });
  });
}

function parseBody(resp) {
  let body = resp && resp.body;
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch (e) { return {}; }
}

// 统一 User-Agent：账户资源汇总接口(get-user-resource-summary)的网关会拦截没有
// User-Agent 的请求（返回 code=10085“请求不合法”），其余接口也兼容该头，故统一带上。
const USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function headersWithToken(token) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Authorization": "Bearer " + token,
    "User-Agent": USER_AGENT
  };
}

// ============ 步骤1：刷新令牌 ============
async function refreshToken() {
  const rt = getRt();
  if (!rt || rt.length < 20) {
    throw new Error("尚未获取长效令牌：请先安装 workbuddy.sgmodule 捕获重写，打开 WorkBuddy App/小程序登录一次；或手动填写脚本顶部 MANUAL_REFRESH_TOKEN");
  }
  const resp = await httpRequest(REFRESH_URL, "POST", {
    "Content-Type": "application/json",
    "X-Refresh-Token": rt,
    "X-Auth-Refresh-Source": "plugin",
    "X-Domain": "copilot.tencent.com"
  }, "{}");
  const data = parseBody(resp);
  if (data.code !== 0 || !data.data || !data.data.accessToken) {
    throw new Error("刷新令牌失败(code=" + (data.code != null ? data.code : "?") + "): " + (data.msg || data.message || "令牌可能已失效，请重新开捕获重写登录一次"));
  }
  result.refreshed = true;
  if (data.data.refreshToken) _newRt = data.data.refreshToken;
  return data.data.accessToken;
}

// ============ 步骤2：查签到状态 ============
async function getStatus(token) {
  const resp = await httpRequest(STATUS_URL, "POST", headersWithToken(token), "{}");
  const data = parseBody(resp);
  if (data.code === 0 && data.data) {
    const d = data.data;
    result.streak = d.streak_days != null ? d.streak_days : null;
    // 今日签到可领积分（普通日 100，第 7 天 1000）。
    // 注意：这里的 total_credits 是“签到活动赛季周期”的数字，并非账户余额，切勿当作余额。
    result.dailyCredit = d.daily_credit != null ? d.daily_credit : null;
    return d.today_checked_in === true;
  }
  if (String(data.code) === "10001") return true;
  return false;
}

// ============ 步骤3：查询真实账户积分余额 ============
// 账户资源汇总接口：data.TotalCredits = 各资源包剩余可用积分之和（字符串，可能含小数）。
// 必须在签到/旅行领取等动作全部完成后再调用，拿到的才是到账后的最新余额。
async function getBalance(token) {
  try {
    const resp = await httpRequest(BALANCE_URL, "POST", headersWithToken(token), "{}");
    const data = parseBody(resp);
    if (data && data.code === 0 && data.data) {
      const v = data.data.TotalCredits;
      if (v != null && v !== "" && !isNaN(Number(v))) return Number(v);
    }
  } catch (e) {}
  return null;
}

// 余额展示：消除浮点误差，最多保留两位小数；整数则不带小数点
function formatBalance(v) {
  if (v == null || isNaN(v)) return "";
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ============ 步骤4：领取签到 ============
async function doCheckin(token) {
  const resp = await httpRequest(CHECKIN_URL, "POST", headersWithToken(token), "{}");
  const data = parseBody(resp);
  if (data.code === 0) {
    result.checkin = "clicked";
    result.gained = true;
    const dd = data.data || {};
    if (dd.streak_days != null) result.streak = dd.streak_days;
    if (dd.credit != null) result.dailyCredit = dd.credit;   // 本次实际到账积分
    return "clicked";
  }
  if (String(data.code) === "10001" || /已签到/.test(data.msg || data.message || "")) {
    result.checkin = "skip_already_signed";
    return "skip_already_signed";
  }
  result.checkin = "error:" + (data.msg || data.message || data.code);
  return result.checkin;
}

// ============ 步骤5：派猫猫旅行 ============
async function travelFlow(token) {
  try {
    const sResp = await httpRequest(TRAVEL_STATUS_URL, "GET", headersWithToken(token), undefined);
    const sData = parseBody(sResp);
    if (sData.code !== 0 || !sData.data) { result.travel = "unavailable"; return; }
    const st = sData.data;

    if (st.state === "arrived") {
      await httpRequest(TRAVEL_CLAIM_URL, "POST", headersWithToken(token), "{}");
      const s2Resp = await httpRequest(TRAVEL_STATUS_URL, "GET", headersWithToken(token), undefined);
      const s2Data = parseBody(s2Resp);
      if (s2Data.code === 0 && s2Data.data) {
        if (s2Data.data.state === "idle" && s2Data.data.daily_limit_reached !== true) {
          await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
            JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
          result.travel = "claimed_and_departed";
        } else {
          result.travel = "claimed";
        }
      }
      return;
    }

    if (st.state === "idle" && st.daily_limit_reached !== true) {
      await httpRequest(TRAVEL_DEPART_URL, "POST", headersWithToken(token),
        JSON.stringify({ location_id: Math.floor(Math.random() * 4) + 1 }));
      result.travel = "departed";
      return;
    }

    if (st.state === "traveling") { result.travel = "traveling"; return; }
    result.travel = "daily_limit_reached";
  } catch (e) {
    result.travel = "unavailable";
  }
}

// ============ 通知（Surge $notification.post） ============
function notify(title, subtitle, body) {
  try {
    if (typeof $notification !== "undefined" && $notification
        && $notification.post) {
      $notification.post(title, subtitle, body);
    }
  } catch (e) {}
}

// ============ 主流程 ============
async function main() {
  let token = "";
  try {
    token = await refreshToken();
    const already = await getStatus(token);
    if (already) {
      result.checkin = "skip_already_signed";
    } else {
      await doCheckin(token);
    }
    await travelFlow(token);
    // 领取旅行到达奖励同样会增加积分，计入“本次有到账”
    if (result.travel === "claimed" || result.travel === "claimed_and_departed") {
      result.gained = true;
    }
    // 有积分到账时，稍等服务端入账，再查询真实余额，避免读到旧值
    if (result.gained) await sleep(1000);
    result.balance = await getBalance(token);
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    // 即便中途出错，只要令牌已拿到，也尽量补查一次余额
    if (token && result.balance == null) {
      try { result.balance = await getBalance(token); } catch (e2) {}
    }
  }

  if (_newRt) saveRt(_newRt);

  const balText = formatBalance(result.balance);
  const balLine = balText ? "💰 " + balText : "";
  let sub, body;
  if (result.error) {
    sub = "⚠️ 签到遇到问题";
    const lines = [result.error];
    if (balText) lines.push("💰 当前余额 " + balText);
    body = lines.join("\n");
  } else {
    // 领取积分必须真实：刚签到时取签到接口返回的“实际到账 credit”(data.data.credit)，
    // 已签时取签到状态接口的“今日额度 daily_credit”（今天签到即已获得该额度）。
    // 接口没给数字时不显示 +N，绝不拿默认值 100 冒充。
    const gain = result.dailyCredit != null ? result.dailyCredit : null;
    const gainText = gain != null ? " +" + gain : "";
    const signText = result.checkin === "clicked" ? "🎉 签到成功" + gainText
      : (result.checkin === "skip_already_signed" ? "✅ 今日已签到" + gainText : "⚠️ " + result.checkin);
    const streakLine = result.streak != null ? "📅 连续签到 " + result.streak + " 天" : "";
    const travelLine = result.travel === "claimed_and_departed" ? "🐱 旅行奖励已领取，已再次出发"
      : result.travel === "departed" ? "🐱 Buddy 已出发旅行"
      : result.travel === "claimed" ? "🐱 旅行奖励已领取"
      : result.travel === "traveling" ? "🐱 Buddy 旅行中"
      : result.travel === "daily_limit_reached" ? "🐱 今日旅行次数已用完"
      : "";  // unavailable 时不显示，避免噪音
    sub = signText + (balText ? "　" + balLine : "");
    body = [streakLine, travelLine].filter(Boolean).join("\n");
  }
  notify("🎯 WorkBuddy 签到", sub, body);
  console.log("[WorkBuddy " + VERSION + "] " + JSON.stringify(result));
  $done();
}

main();
