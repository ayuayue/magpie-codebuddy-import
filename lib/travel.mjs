// 派猫猫旅行：成长中心的活动，接口流程与周期照抄 workbuddy-switch 的
// travel.rs（派发 30 分钟一轮，领奖检查 15 分钟一轮，按北京日缓存）。
// 只有国内版有成长中心，国际版账号不参与。

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { readAccounts } from "./accounts.mjs"

const WEB = "https://www.codebuddy.cn"
const PREFIX = "/activity/growth/buddy/travel"
const STATE_FILE = "travel-state.json"
// 界面上的开关要展开「接了 CodeBuddy 的 agent」才看得见；放一个空文件
// travel-on 也能打开，两个条件满足其一就行。
const ON_MARKER = "travel-on"

export function travelEnabled(directory, magpie, provider) {
  if (magpie?.option?.(provider, TRAVEL_OPTION) === true) return true
  try {
    return existsSync(join(directory || ".", ON_MARKER))
  } catch {
    return false
  }
}

export const TRAVEL_OPTION = "travel"
export const CLAIM_MS = 15 * 60 * 1000 // 领奖检查
export const DISPATCH_MS = 30 * 60 * 1000 // 派发补一轮

// 北京日：活动是国内平台的，按北京日滚动，不跟着机器时区走
function beijingDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

function statePath(directory) {
  return join(directory || ".", STATE_FILE)
}

function readTravel(directory) {
  try {
    const kept = JSON.parse(readFileSync(statePath(directory), "utf8"))
    if (!kept || typeof kept !== "object") throw new Error("bad")
    return { date: kept.date ?? "", accounts: kept.accounts ?? {}, log: Array.isArray(kept.log) ? kept.log : [] }
  } catch {
    return { date: "", accounts: {}, log: [] }
  }
}

function writeTravel(directory, state) {
  writeFileSync(statePath(directory), JSON.stringify(state, null, 2) + "\n")
}

// 请求头照抄 workbuddy-switch 的 build_travel_headers：成长中心是网页端的接口
function headers(auth) {
  return {
    authorization: "Bearer " + (auth.access ?? ""),
    accept: "application/json",
    "content-type": "application/json",
    "x-user-id": auth.uid ?? "",
    ...(auth.domain ? { "x-domain": auth.domain } : {}),
    ...(auth.enterpriseId ? { "x-enterprise-id": auth.enterpriseId, "x-tenant-id": auth.enterpriseId } : {}),
    "x-client-platform": "web",
    origin: WEB,
    referer: WEB + "/profile/growth-center",
  }
}

async function call(auth, path, method, body, fetchImpl) {
  const res = await (fetchImpl ?? globalThis.fetch)(WEB + path, {
    method,
    headers: headers(auth),
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status === 401) {
    const e = new Error("401 Unauthorized")
    e.unauthorized = true
    throw e
  }
  const env = await res.json().catch(() => null)
  if (!env) throw new Error("响应不是 JSON")
  const code = typeof env.code === "number" ? env.code : -1
  if (code !== 0 && code !== 200) throw new Error(env.msg ?? env.message ?? "code " + code)
  return env.data ?? {}
}

// runTravel 走一轮：领奖每次都查，派发只在 dispatch 轮里做。
export async function runTravel({ directory, provider, dispatch, travelOn, fetchImpl, log, marker }) {
  const state = readTravel(directory)
  const today = beijingDay()
  if (state.date !== today) {
    state.date = today
    state.accounts = {}
    state.log = []
  }
  const note = (uid, what, detail) => {
    const line = new Date().toISOString() + " " + uid + " " + what + (detail ? " " + detail : "")
    state.log.push(line)
    if (state.log.length > 200) state.log.splice(0, state.log.length - 200)
    log?.(what + " " + uid + (detail ? " " + detail : ""))
  }

  let acted = 0
  for (const { key, auth } of readAccounts(directory, provider)) {
    const uid = auth.uid || key
    const entry = { ...(state.accounts[uid] ?? {}) }
    if (entry.done) continue
    if (!auth.access) {
      state.accounts[uid] = { ...entry, skip: "no-token" }
      continue
    }
    if (typeof auth.expires === "number" && auth.expires > 0 && auth.expires < Date.now() + 60_000) {
      // token 过期交给 magpie 下一次请求时续期，这里不碰 refresh token
      state.accounts[uid] = { ...entry, skip: "token-expired" }
      continue
    }
    try {
      const st = await call(auth, PREFIX + "/status", "GET", undefined, fetchImpl)
      if (st.state === "arrived") {
        const got = await call(auth, PREFIX + "/claim", "POST", { record_id: st.record_id ?? 0 }, fetchImpl)
        const reward = got.reward_credit ?? null
        state.accounts[uid] = { ...entry, claimed: true, reward, dispatched: true }
        delete state.accounts[uid].skip
        note(uid, "领奖", reward == null ? "" : "+" + reward)
        acted += 1
      } else if (st.state === "traveling") {
        state.accounts[uid] = { ...entry, traveling: true }
        delete state.accounts[uid].skip
      } else if (st.state === "idle") {
        if (st.daily_limit_reached) {
          state.accounts[uid] = { ...entry, done: true, skip: "daily-limit" }
          note(uid, "今日上限已到")
        } else if ((!travelOn && !marker) || !dispatch) {
          state.accounts[uid] = entry
        } else if (entry.dispatched) {
          // 领完奖又回到 idle：等下一个派发轮再试，不重复派
          state.accounts[uid] = entry
        } else {
          const cfg = await call(auth, PREFIX + "/config", "GET", undefined, fetchImpl)
          const location = Array.isArray(cfg.locations) ? cfg.locations[0] : null
          if (!location) {
            state.accounts[uid] = { ...entry, skip: "no-location" }
          } else {
            await call(auth, PREFIX + "/depart", "POST", { location_id: location.id }, fetchImpl)
            state.accounts[uid] = { ...entry, dispatched: true, location: location.name ?? "" }
            delete state.accounts[uid].skip
            note(uid, "派出", location.name ?? "")
            acted += 1
          }
        }
      } else {
        state.accounts[uid] = { ...entry, skip: "unknown-state:" + String(st.state) }
      }
    } catch (e) {
      state.accounts[uid] = { ...entry, skip: e?.unauthorized ? "unauthorized" : String(e?.message ?? e) }
    }
  }

  writeTravel(directory, state)
  return acted
}

let started = false

// startTravelLoop 开两条循环：启动先跑一轮，之后领奖 15 分钟、派发 30 分钟。
export function startTravelLoop({ directory, provider, magpie, client, fetchImpl }) {
  if (started || !directory) return
  started = true

  const log = (message) => {
    try {
      client?.app?.log?.({ body: { level: "info", service: "travel", message } })
    } catch {}
  }
  const on = () => travelEnabled(directory, magpie, provider)
  const tick = async (dispatch) => {
    if (!on()) return // 开关关着就不打任何请求
    try {
      await runTravel({ directory, provider, dispatch, travelOn: true, fetchImpl, log })
    } catch {}
  }

  tick(true)
  setInterval(() => tick(false), CLAIM_MS).unref?.()
  setInterval(() => tick(true), DISPATCH_MS).unref?.()
}
