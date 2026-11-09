# WorkBuddy 每日自动签到（Surge）

腾讯 WorkBuddy（CodeBuddy）「Buddy 加油站」自动签到 Surge 模块：打开 App / 小程序登录一次，重写脚本自动捕获长效令牌；之后每日由定时任务自动完成签到、领取 Buddy 旅行奖励、播报真实积分余额，长效令牌自动滚动续期，无需再管。

> 本仓库为 Surge 专用远程订阅，与 Quantumult X 版本（[workbuddy-qx](https://github.com/roamout/workbuddy-qx)）逻辑一致，仅底层 API 不同。

## 功能

- **一键捕获令牌**：重写脚本自动抓取登录 / 刷新请求中的 `refresh_token`
- **每日自动签到**：每日 +100 积分，第 7 天 +1000，重复运行幂等
- **Buddy 旅行闭环**：自动领取到达奖励、再次派出旅行
- **真实积分余额**：领取完成后查账户资源汇总，播报真实可用积分
- **令牌自动续期**：每次运行回写轮换出的新令牌，长期有效

## 安装（模块订阅地址）

**GitHub raw 版**：

```
https://raw.githubusercontent.com/roamout/workbuddy-surge/main/workbuddy.sgmodule
```

**jsDelivr CDN 版（国内网络推荐）**：

```
https://cdn.jsdelivr.net/gh/roamout/workbuddy-surge@main/workbuddy.cdn.sgmodule
```

> 两个版本二选一，不要同时装。区别仅在于模块内脚本走 GitHub raw 还是 jsDelivr。

## 使用步骤

1. Surge → 模块 → 安装新模块，粘贴上面的地址。
2. 开启 MitM，安装并信任证书。
3. 打开 WorkBuddy App / 小程序，退出账号重新登录一次，收到「✅ 令牌捕获成功」通知。
4. 停用捕获重写，保留「WorkBuddy 签到」定时任务（每天 09:03 自动运行）。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `workbuddy.sgmodule` | 模块（raw 版） |
| `workbuddy.cdn.sgmodule` | 模块（CDN 版，国内推荐） |
| `workbuddy_capture_token.surge.js` | 令牌捕获重写脚本（一次性） |
| `workbuddy_checkin.surge.js` | 每日签到定时任务脚本 |

## 安全与隐私

- 长效令牌只存在你本机的 Surge 持久化存储中，不向任何第三方上传。
- 本项目仅供学习交流，账号相关数据归腾讯所有，请遵守服务条款，风险自负。
