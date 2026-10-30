// 在社区 WorkBuddy 插件之上补一个「导入账号 JSON」登录方式：
// 把 workbuddy-switch 导出的账号（access/refresh token）直接变成 magpie 的登录，
// 不必每个账号都走一遍浏览器授权。整份导出粘一次就全导入。
//
// provider id 对外改成 codebuddy / codebuddy-ai（上游是 workbuddy / workbuddy-ai），
// 请求转发、模型列表、token 续期、用量卡片全部沿用社区插件
// （vendor/opencode-workbuddy-auth.mjs，@magpie-community/opencode-workbuddy-auth 0.1.41，MIT）。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  WorkBuddyAIAuthPlugin,
  WorkBuddyAuthPlugin,
  _internal,
} from "./vendor/opencode-workbuddy-auth.mjs"
import {
  ID_RENAMES,
  accountsFrom,
  addAccounts,
  authOf,
  keyOf,
  nameOf,
  renameProviderKeys,
  variantOf,
} from "./lib/accounts.mjs"
import { TRAVEL_OPTION, startTravelLoop } from "./lib/travel.mjs"
import { beijingDay, dayWindows, meterAsked } from "./lib/usage.mjs"

// oldId → 新 id 与显示名
const SITES = {
  workbuddy: { id: "codebuddy", name: "CodeBuddy", variant: "cn" },
  "workbuddy-ai": { id: "codebuddy-ai", name: "CodeBuddy AI", variant: "ai" },
}

// 已导入过的账号记在这里（按档位），免得同一份导出被重复粘贴时又添一份。
// 删掉这个文件就可以从头再来。
const STATE_FILE = "workbuddy-import-state.json"

function statePath(directory) {
  return join(directory || ".", STATE_FILE)
}

function readState(directory) {
  try {
    const kept = JSON.parse(readFileSync(statePath(directory), "utf8"))
    return kept && typeof kept === "object" ? kept : {}
  } catch {
    return {}
  }
}

function writeState(directory, state) {
  const path = statePath(directory)
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + ".tmp"
  writeFileSync(temp, JSON.stringify(state, null, 2))
  renameSync(temp, path)
}

// WorkBuddy 的每日签到。上游插件没有 auth.checkin，magpie 内置的代签又只认
// provider id "workbuddy"——这里自己实现，接口流程照抄 magpie 的
// workbuddy_checkin.go：先查活动状态，未签则领。请求头按 workbuddy-switch 的
// billing 请求配（不带 WorkBuddy 客户端 UA 也能调这些接口），Origin 跟随请求 host。
//
// 接口返回是 snake_case（today_checked_in、streak_days）。早前照 camelCase 读，
// 每次都以为「今天还没签」，转去调 claim，被 WorkBuddy 以 HTTP 400
// code 10001「今天已签到，请明天再来」顶回来 —— 10001 是它的通用错误码，
// 1001/1002/1003 那套并没用上，所以只能按文案分辨：否则一条本来已签成功的
// 记录会被记成 failed，那句提示在卡片上一挂就是一整天。
const ALREADY = /已签到|已打卡|明天再来|already\b.*check(?:ed)?\s*in|come back tomorrow/i
const INELIGIBLE = /不符合|不满足|未参与|不具备|not eligible|ineligible/i
const ENDED = /已结束|活动结束|已过期|activit\w* (?:ended|over)|expired/i

const pick = (...names) => (o) => names.map((n) => o?.[n]).find((v) => v !== undefined && v !== null)
const num = (v) => (typeof v === "number" ? (Number.isFinite(v) ? v : undefined) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined)
const yes = (v) => v === true || v === 1 || v === "1" || v === "true"

// until 下一个北京零点：WorkBuddy 的签到按北京日重置，告诉 magpie 这个答案几时
// 作废，它就不必到中午前反复追问，也不会把昨天尾边的答案记到今天。
function nextBeijingDay(at = Date.now()) {
  const bj = new Date(at + 8 * 3600_000)
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1) - 8 * 3600_000).toISOString()
}

function makeCheckin(vendor, client, newId, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const origin = new URL(vendor.endpoint).origin

  async function call(auth, path) {
    const res = await doFetch(vendor.endpoint + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + auth.access,
        accept: "application/json",
        "content-type": "application/json",
        "x-user-id": auth.uid ?? "",
        ...(auth.domain ? { "x-domain": auth.domain } : {}),
        ...(auth.enterpriseId ? { "x-enterprise-id": auth.enterpriseId, "x-tenant-id": auth.enterpriseId } : {}),
        "x-client-platform": "web",
        origin,
        referer: origin + "/profile/plans-usage",
      },
      body: JSON.stringify({}),
    })
    if (res.status === 401) {
      const e = new Error("401 Unauthorized")
      e.status = 401
      throw e
    }
    const env = await res.json().catch(() => ({}))
    const code = Number(env?.code) || 0
    if (code && code !== 200) {
      const e = new Error(env.msg ?? env.message ?? "code " + env.code)
      e.code = code
      throw e
    }
    return env?.data ?? env ?? {}
  }

  return {
    provider: newId,
    async checkin(getAuth) {
      const stored = await getAuth()
      if (stored?.type !== "oauth" || !(stored.access || stored.source)) {
        throw new Error("这个账号没有可用的登录，先登录再签到")
      }
      // token 快过期时先续期（续期结果由 magpie 存回）
      const auth = await _internal.fresh(vendor, client, stored)
      const until = nextBeijingDay()
      let status
      try {
        status = await call(auth, "/v2/billing/meter/checkin-activity-status")
      } catch (e) {
        if (e.status === 401) {
          // 签到 401 但额度读得动：WorkBuddy 的签到只认它自家 App 的设备令牌。
          // 额度的读法要和用量那条一致（WorkBuddy 客户端的头），否则本来好的
          // 账号会被误判成登录失效
          try {
            await meterAsked(vendor, auth, "/billing/meter/get-user-resource-summary", {}, doFetch)
            return {
              outcome: "inactive",
              until,
              message: "WorkBuddy 的签到只认它自己的 App（缺设备令牌），请在 WorkBuddy App 里签到",
            }
          } catch {
            throw new Error("WorkBuddy 拒绝了这个账号的登录（401），请重新登录")
          }
        }
        // 查不到状态不等于签到失败：按文案给个说法，别把读不到报成签不进
        if (ALREADY.test(e.message)) return { outcome: "done", until, message: e.message }
        if (ENDED.test(e.message)) return { outcome: "inactive", until, message: e.message }
        if (INELIGIBLE.test(e.message)) return { outcome: "ineligible", until, message: e.message }
        throw e
      }
      if (!yes(status?.active ?? status?.isActive ?? status?.active_status)) {
        return { outcome: "inactive", until }
      }
      const credit = num(pick("todayCredit", "today_credit")(status))
      const streak = num(pick("streakDays", "streak_days")(status))
      const dates = pick("checkinDates", "checkin_dates")(status)
      if (yes(pick("todayCheckedIn", "today_checked_in")(status)) || (Array.isArray(dates) && dates.includes(beijingDay(0)))) {
        return { outcome: "done", credit, streak, until }
      }
      try {
        const got = await call(auth, "/v2/billing/meter/daily-checkin")
        return {
          outcome: "claimed",
          credit: num(pick("credit", "creditAmount", "credit_amount", "todayCredit", "today_credit")(got)) ?? credit,
          streak: num(pick("streakDays", "streak_days")(got)) ?? streak,
          message: pick("message", "msg")(got),
          until,
        }
      } catch (e) {
        if (e.code === 1001 || ALREADY.test(e.message)) return { outcome: "done", streak, until, message: e.message }
        if (e.code === 1002 || INELIGIBLE.test(e.message)) return { outcome: "ineligible", message: e.message, until }
        if (e.code === 1003 || ENDED.test(e.message)) return { outcome: "inactive", message: e.message, until }
        throw e
      }
    },
  }
}

// 卡片上 Credits 条那一行的已用数：今日的实时下限由它推出来
function usedCredits(windows) {
  const list = Array.isArray(windows) ? windows : []
  const named = list.find((w) => w && w.name === "Credits" && Number.isFinite(w.amount))
  if (named) return named.amount
  const any = list.find((w) => w && !w.aside && Number.isFinite(w.amount))
  return any ? any.amount : undefined
}

const IMPORT_HINT =
  "不用浏览器：把账号 JSON 粘到下面的输入框，再点「登录」。" +
  "（这个框在 magpie 里叫「验证码」，这里不是验证码。）"

function importMethod(site, directory) {
  return {
    type: "oauth",
    label: site.name + "：导入账号 JSON",
    authorize: async () => ({
      // 不需要打开任何页面：粘贴一段 JSON 就够了。
      url: "",
      method: "code",
      instructions:
        IMPORT_HINT +
        "粘整份导出文件也行：属于 " + site.name + " 的会在这里导入，另一个档位的账号一并写进 magpie。" +
        "也可以写 file:路径。",
      async callback(code) {
        try {
          const parsed = accountsFrom(code)
          const mine = parsed.filter((a) => variantOf(a) === site.variant)
          if (!mine.length) {
            throw new Error(
              "这份 JSON 里没有 " + site.name + " 的账号（按 variant/domain 分档）。" +
                (parsed.length ? "其中 " + parsed.length + " 个属于另一个档位，请到那边导入。" : ""),
            )
          }

          const state = readState(directory)
          const seen = new Set(Array.isArray(state[site.variant]) ? state[site.variant] : [])
          const fresh = mine.filter((a) => {
            const key = keyOf(a)
            return key && !seen.has(key)
          })
          if (!fresh.length) {
            throw new Error(
              "这份 JSON 里的 " + mine.length + " 个 " + site.name + " 账号都导入过了。" +
                "要重新导入，删掉 " + statePath(directory) + " 再试。",
            )
          }

          // magpie 一次登录只收一个账号：选中的交给它保存，其余的直接写进账号库。
          const chosen = fresh[0]
          const rest = []
          for (const account of parsed) {
            if (account === chosen) continue
            const key = keyOf(account)
            if (!key) continue
            const own = variantOf(account)
            if ((state[own] || []).includes(key)) continue
            try {
              authOf(account) // 加密信封会在这里抛错，跳过它
              rest.push(account)
            } catch {}
          }

          const written = addAccounts(directory, rest)

          const mark = (account) => {
            const own = variantOf(account)
            const set = new Set(Array.isArray(state[own]) ? state[own] : [])
            const key = keyOf(account)
            if (key) set.add(key)
            state[own] = [...set]
          }
          mark(chosen)
          for (const account of rest) mark(account)
          writeState(directory, state)

          const auth = authOf(chosen)
          const total = 1 + written.length
          return {
            type: "success",
            access: auth.access,
            refresh: auth.refresh,
            expires: auth.expires,
            accountId: nameOf(chosen),
            uid: auth.uid,
            domain: auth.domain,
            tokenType: auth.tokenType,
            ...(auth.refreshExpiresAt ? { refreshExpiresAt: auth.refreshExpiresAt } : {}),
            ...(auth.enterpriseId ? { enterpriseId: auth.enterpriseId } : {}),
            ...(total > 1 ? { message: "这次一共导入 " + total + " 个账号。" } : {}),
          }
        } catch (e) {
          return { type: "failed", error: e?.message ?? String(e) }
        }
      },
    }),
  }
}

function withImport(factory, oldId) {
  const site = SITES[oldId]
  const newId = site.id
  // 上游的 site 对象（endpoint/app 等）给签到和续期用
  const site0 = _internal.SITES[oldId]
  return async (input, options) => {
    // 上游内部用旧 id 认 provider：把 option 查询和 auth.set 的 path 都翻译成新 id
    const magpie = input?.magpie
    if (magpie && typeof magpie.option === "function") {
      const original = magpie.option.bind(magpie)
      magpie.option = (id, key) => original(id === oldId ? newId : id, key)
    }
    const client = input?.client
    if (client?.auth && typeof client.auth.set === "function") {
      const fix = (opts) =>
        opts?.path?.id === oldId ? { ...opts, path: { ...opts.path, id: newId } } : opts
      input.client = {
        ...client,
        auth: {
          ...client.auth,
          set: async (opts) => client.auth.set(fix(opts)),
          remove: async (opts) => client.auth.remove(fix(opts)),
        },
      }
    }

    const hooks = await factory(input, options)

    hooks.auth.provider = newId
    if (hooks.provider && typeof hooks.provider === "object") hooks.provider.id = newId

    const methods = hooks?.auth?.methods
    if (Array.isArray(methods)) {
      for (const method of methods) {
        if (typeof method?.label !== "string") continue
        // 先换 "WorkBuddy AI"，否则会变成 "CodeBuddy AI AI"
        method.label = method.label
          .replaceAll("WorkBuddy AI", "CodeBuddy AI")
          .replaceAll("WorkBuddy", site.name)
      }
      methods.push(importMethod(site, input?.directory))
    }

    // 上游的 config 钩子把供应商登记成旧 id：搬到这里，并换显示名
    const baseConfig = hooks?.config
    if (typeof baseConfig === "function") {
      hooks.config = async (config) => {
        await baseConfig(config)
        const p = config?.provider?.[oldId]
        if (p) {
          config.provider[newId] = p
          delete config.provider[oldId]
        }
        const renamed = config?.provider?.[newId]
        if (renamed) renamed.name = site.name
      }
    }

    // chat.headers 里上游按旧 id 判 providerID，改 id 后会跳过；这里补上会话头
    const baseHeaders = hooks?.["chat.headers"]
    if (typeof baseHeaders === "function") {
      hooks["chat.headers"] = async (input2, output) => {
        await baseHeaders(input2, output)
        const id = input2?.model?.providerID ?? input2?.provider?.info?.id
        if (id === newId && input2?.sessionID && output?.headers) {
          output.headers[_internal.SESSION] = String(input2.sessionID).slice(0, 128)
        }
      }
    }

    // 派猫猫旅行的开关：国内版才有成长中心，默认关
    if (newId === "codebuddy") {
      if (!Array.isArray(hooks.auth.options)) hooks.auth.options = []
      hooks.auth.options.push({
        key: TRAVEL_OPTION,
        label: "自动派猫猫旅行",
        description: "派发 5 小时一轮、领奖 45 分钟一轮，夜里不发请求；只跑国内版账号，默认关。开关在 Providers 页展开 CodeBuddy 那一行里，或放一个 travel-on 文件，或用 node scripts/travel.mjs on。只想跑一次：node scripts/travel.mjs run。",
      })
    }

    // 上游没有签到钩子：补上，magpie 每天替每个账号签一次
    if (!hooks.auth.checkin) {
      const checkin = makeCheckin(site0, input?.client, newId, input?.fetchImpl)
      hooks.auth.checkin = checkin.checkin
    }

    // 上游报的一周期已用是几十个滚动 30 天包的加总，包一过期就倒退，而 magpie
    // 的按天用量只能取相邻两次读数的差、倒退就当没发生 —— 于是当天常显示 0。
    // 这里补一行真数：WorkBuddy 自己的请求流水按北京日聚合（含从它自家 App 走的
    // 请求）。不给 used/amount/limit，magpie 就当纯展示行，既不参与按天差分，也
    // 不影响路由看剩余额度。读不到就什么也不加，卡片照旧。
    const baseUsage = hooks?.auth?.usage
    if (typeof baseUsage === "function") {
      hooks.auth.usage = async (getAuth) => {
        const out = await baseUsage(getAuth)
        if (!out || out.error || out.signIn === "expired") return out
        try {
          const stored = await getAuth()
          const a = await _internal.fresh(site0, input?.client, stored)
          // 条上那个一周期已用是今日实时下限的来源：流水 5 分钟才封一桶，这中间
          // 的几分钟靠它顶着，免得刚用完积分时条在动、「今日」不动
          out.windows = [
            ...(out.windows ?? []),
            ...(await dayWindows(site0, a, {
              fetchImpl: input?.fetchImpl,
              amount: usedCredits(out.windows),
              directory: input?.directory,
              uid: stored?.uid,
            })),
          ]
        } catch {}
        return out
      }
    }

    // 派猫猫旅行的后台循环（开关在每轮里读，关着就不发请求）
    if (newId === "codebuddy" && input?.directory) {
      try {
        startTravelLoop({ directory: input.directory, provider: newId, magpie, client: input?.client, fetchImpl: input?.fetchImpl })
      } catch {}
    }

    // 老版本存下来的账号还在旧 id 下：搬一次
    if (input?.directory) {
      try {
        await renameProviderKeys(input.directory, ID_RENAMES.filter(([from]) => from === oldId))
      } catch {}
    }

    return hooks
  }
}

export const WorkBuddyImportPlugin = withImport(WorkBuddyAuthPlugin, "workbuddy")
export const WorkBuddyAIImportPlugin = withImport(WorkBuddyAIAuthPlugin, "workbuddy-ai")
