# magpie-workbuddy-import

给 magpie 的 WorkBuddy 插件（`@magpie-community/opencode-workbuddy-auth`）加一个
**导入账号 JSON** 的登录方式：把 [workbuddy-switch](https://github.com/changexbc/workbuddy-switch)
导出的账号直接变成 magpie 里的登录，不用每个账号都走一遍浏览器授权。

请求转发、模型列表、token 续期、用量/额度卡片全部是社区插件的代码，这里只多一个导入口。

## 装

```sh
magpie plugin add github:ayuayue/magpie-codebuddy-import
```

插件装好后重启 magpie 生效。本地改代码调试时也可以直接装目录：
`magpie plugin add "<插件目录>"`。

装完 `magpie plugin list` 应该看到：

```
magpie-workbuddy-import  on
  codebuddy-ai (CodeBuddy AI, 16 models)  not signed in
  codebuddy (CodeBuddy, 15 models)  not signed in
```

## 用

Providers → 添加账号 → 选择登录方式（**不是**点卡片上的「登录」，那个直接走浏览器）：

```
How do you sign in to WorkBuddy?
  1. CodeBuddy account (browser)
  2. CodeBuddy desktop's sign-in
  3. CodeBuddy API key
  4. CodeBuddy：导入账号 JSON   ← 选这个
```

选了之后标题仍然是「在浏览器里完成登录」，输入框标着「验证码」——**那只是 magpie
对 code 类登录方式的通用文案**，不用浏览器。把 JSON 粘进那个框，点「登录」。

**整份导出文件一次就能导完**：属于当前档位的账号由 magpie 保存，属于另一个档位的
账号也一并写进 magpie，不用分两次。账号多了可以写 `file:` 路径代替粘贴：

```text
file:C:\path\to\wb-switch-accounts.json
```

已经导入过的 uid 会跳过，同一份文件反复粘不会变成两份。

终端里等价：

```sh
magpie plugin login codebuddy        # 选第 4 项，粘贴 JSON 或 file:路径
```

## JSON 格式

一个数组，每个元素一个账号；单个对象也行。完整示例见
[`accounts.template.json`](accounts.template.json)。

| 字段 | 必填 | 说明 |
| :-- | :-- | :-- |
| `access_token` | 是 | 账号的 access token。也认 `accessToken`、`auth_raw.auth.accessToken` |
| `refresh_token` | 建议 | 没有就只能在 access token 过期前用 |
| `uid` | 建议 | 请求头 `X-User-Id` 用它；magpie 也靠它判重 |
| `variant` | 否 | `cn` / `ai`（`global`、`intl` 也认）。缺省按 `domain` 判断 |
| `domain` | 否 | 国内 `www.codebuddy.cn`，国际 `www.workbuddy.ai` |
| `nickname` / `email` | 否 | 账号在 magpie 里显示的名字，缺省用 uid |
| `expiresAt` | 否 | 毫秒时间戳；填了可以提前续期 |
| `refreshExpiresAt` | 否 | 毫秒时间戳 |
| `enterpriseId` | 否 | 企业版账号才需要 |
| `token_type` | 否 | 默认 `Bearer` |

workbuddy-switch 导出的记录原样就能用（它是 `access_token` + `refresh_token` +
`uid` + `variant` 这套字段）。字段名用 snake_case 或 camelCase 都行，嵌套在
`auth_raw.auth` 里的写法也认。

**加密的 token 导不进来**：WorkBuddy 5.6 起桌面端会把 token 存成
`{"$wbEncrypted": 1, ...}`，只有 App 自己解得开。遇到这种账号会明确报错，
请在 magpie 里用「浏览器登录」重新授权。

## 批量脚本（可选）

不想点界面、或者要写进别的流程时：

```sh
node scripts/import.mjs "C:\path\to\wb-switch-accounts.json"
node scripts/import.mjs          # 不带参数：自动找 Downloads / 桌面里最新的 wb-switch-accounts*.json
```

也可以双击 `导入账号.cmd`，或把 json 拖到它上面。脚本只是替你调 `magpie plugin login`，
和界面走的是同一条路。

## 名称与 id

界面里显示 **CodeBuddy / CodeBuddy AI**，但 provider id 仍是 `workbuddy` /
`workbuddy-ai`（上游插件定的）：

- 模型 id 还是 `workbuddy/glm-5.3`、`workbuddy-ai/...` 这种前缀；
- 账号在 `plugin-auth.json` 里也按这两个 id 存。

所以 CLI 命令都写 `workbuddy`：

```sh
magpie plugin login workbuddy
magpie accounts workbuddy
```

- 国内版 id `workbuddy`（copilot.tencent.com）
- 国际版 id `workbuddy-ai`（www.workbuddy.ai）

## 派猫猫旅行

成长中心的活动（接口流程与周期照抄 workbuddy-switch 的 `travel.rs`）：

- 每 **30 分钟**派发一轮（启动先跑一轮），猫猫回来后 **15 分钟**内领奖
- 只跑国内版（`codebuddy`），国际版没有成长中心
- 开关 **默认关**，三种打开方式：
  - 命令：`node scripts/travel.mjs on` / `off`（另有 `status` 看每个账号的进度、`run` 立刻跑一轮）
  - 界面：Providers 页 → **展开 CodeBuddy 这一行** → 面板靠下「自动派猫猫旅行」。开关挂在供应商上，所以给 agent 配了路由组时，要在 codebuddy 那一行里找，不在 agent 的编辑面板里
  - 文件：在 magpie 配置目录放一个名为 `travel-on` 的空文件（`~/.config/magpie/travel-on`），删掉即关
- 每天按北京日重置；`daily_limit_reached`（今天次数用完了）当天就收工
- token 过期或 401 只跳过本轮，不碰 refresh token（刷新交给 magpie，避免两边同时刷新）
- 每一轮的结果记在 `~/.config/magpie/travel-state.json`（按 uid 的状态 + 最近 200 条日志）

## 自动签到

插件补了 `auth.checkin` 钩子（上游没有），magpie 每个北京日替每个已登录账号签一次，
结果显示在账号卡片和 Settings → Usage 里。手动触发：

```sh
magpie accounts checkin
```

接口流程与 magpie 内置的 WorkBuddy 代签一致（查 `checkin-activity-status` → 领
`daily-checkin`）。注意：部分账号 WorkBuddy 只认自家 App 发起的签到（缺设备令牌），
这种情况会提示去 WorkBuddy App 里签。

## 已导入记录

`~/.config/magpie/workbuddy-import-state.json`（Windows 也是这个路径）按档位记着
已导入的 uid。删掉它就能重新导入。

## 更新内嵌的社区插件

`vendor/opencode-workbuddy-auth.mjs` 是
`@magpie-community/opencode-workbuddy-auth@0.1.41` 的副本（MIT，见 `vendor/LICENSE`）：

```sh
curl -sL https://raw.githubusercontent.com/magpie-community/plugins/HEAD/packages/workbuddy/index.mjs \
  -o vendor/opencode-workbuddy-auth.mjs
```

## 测试

```sh
node --test test/import.test.mjs
```

## 卸载

```sh
magpie plugin rm magpie-workbuddy-import
```

`rm` 只删插件，已导入的账号还留在 `plugin-auth.json` 里；要一起清掉就先
`magpie plugin logout codebuddy` / `codebuddy-ai`。

## 和市场里的 workbuddy 插件共存

magpie 对同一个 provider id 只让一个插件提供登录方式，后装的接管。要让本插件接管：

```sh
magpie plugin use github:ayuayue/magpie-codebuddy-import codebuddy
magpie plugin use github:ayuayue/magpie-codebuddy-import codebuddy-ai
```

本插件内嵌的就是市场版的全部代码，接管后浏览器登录、桌面端登录、API key、用量卡片
一个都不少。注意 id 不同（这里叫 codebuddy，市场版叫 workbuddy），接管后要重新登录
或重新导入一次账号。
