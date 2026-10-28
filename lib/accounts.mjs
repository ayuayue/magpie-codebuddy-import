// workbuddy-switch 账号 JSON 的解析与字段映射，插件本体和 scripts/import.mjs 共用。
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// 粘贴的内容可以是单个账号、账号数组、整份导出文件（数组），
// 或者 file:C:\path\accounts.json。
// provider id：上游插件叫 workbuddy / workbuddy-ai，这里对外改成 codebuddy 系。
export const PROVIDERS = { cn: "codebuddy", ai: "codebuddy-ai" }

// 迁移用：plugin-auth.json 里旧 id 的键改成新 id。
export const ID_RENAMES = [
  ["workbuddy", "codebuddy"],
  ["workbuddy-ai", "codebuddy-ai"],
]

function accountsFrom(text) {
  const raw = String(text ?? "").trim()
  if (!raw) throw new Error("没有收到内容。请粘贴 workbuddy-switch 导出的账号 JSON。")

  let body = raw
  if (/^file:/i.test(raw)) {
    const path = raw.slice(5).trim().replace(/^["']|["']$/g, "")
    try {
      body = readFileSync(path, "utf8")
    } catch (e) {
      throw new Error("读不到 " + path + "：" + e.message)
    }
  }

  let data
  try {
    data = JSON.parse(body)
  } catch (e) {
    throw new Error("不是合法 JSON（" + e.message + "）。粘贴一个账号、一个账号数组，或整份导出文件。")
  }

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.accounts)
      ? data.accounts
      : Array.isArray(data?.data)
        ? data.data
        : [data?.account ?? data]

  const accounts = list.filter((a) => a && typeof a === "object" && !Array.isArray(a))
  if (!accounts.length) throw new Error("这份 JSON 里没有账号记录。")
  return accounts
}

function text(value) {
  return typeof value === "string" ? value.trim() : ""
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// 档位：显式 variant 优先，缺失时看 domain，缺省国内版（与 workbuddy-switch 一致）。
function variantOf(account) {
  const said = text(account.variant).toLowerCase()
  if (["ai", "intl", "global", "workbuddy-ai"].includes(said)) return "ai"
  if (["cn", "china", "workbuddy"].includes(said)) return "cn"
  const domain = (text(account.domain) || text(account.auth_raw?.domain)).toLowerCase()
  return domain.includes("workbuddy.ai") ? "ai" : "cn"
}

// WorkBuddy 5.6 起桌面端把 token 存成 {$wbEncrypted: 1, ...}，只有 App 自己
// 解得开。这种账号导入进来也发不出请求，直接说清楚。
function secret(value, what) {
  if (typeof value === "string") return value.trim()
  if (value && typeof value === "object" && "$wbEncrypted" in value) {
    throw new Error(
      "这个账号的 " + what + " 是 WorkBuddy 5.6 起的加密信封，插件解不开。" +
        "请在 magpie 里用「浏览器登录」重新授权这个账号。",
    )
  }
  return ""
}

function authOf(account) {
  const raw =
    account.auth_raw && typeof account.auth_raw === "object"
      ? (account.auth_raw.auth ?? account.auth_raw)
      : {}
  const pick = (name, camel, what) =>
    secret(account[name] ?? account[camel] ?? raw[name] ?? raw[camel], what)

  const access = pick("access_token", "accessToken", "access token")
  if (!access) throw new Error("账号里没有 access_token。")

  const refresh = pick("refresh_token", "refreshToken", "refresh token")
  const now = Date.now()

  const expires =
    number(account.expiresAt) ??
    number(account.expires_at) ??
    number(raw.expiresAt) ??
    (number(account.expiresIn) ? now + number(account.expiresIn) * 1000 : 0)

  const refreshExpiresAt =
    number(account.refreshExpiresAt) ??
    number(account.refresh_expires_at) ??
    number(raw.refreshExpiresAt) ??
    (number(account.refreshExpiresIn) ? now + number(account.refreshExpiresIn) * 1000 : 0)

  return {
    access,
    refresh,
    expires,
    refreshExpiresAt,
    domain: text(account.domain) || text(raw.domain),
    uid:
      text(account.uid) ||
      text(account.auth_raw?.uid) ||
      text(account.profile_raw?.uid) ||
      "",
    enterpriseId:
      text(account.enterpriseId) ||
      text(account.enterprise_id) ||
      text(account.profile_raw?.enterpriseId) ||
      "",
    tokenType: text(account.token_type) || text(account.tokenType) || "Bearer",
  }
}

function nameOf(account) {
  return (
    text(account.nickname) ||
    text(account.email) ||
    text(account.profile_raw?.nickname) ||
    text(account.uid) ||
    "WorkBuddy"
  )
}

function keyOf(account) {
  return (
    text(account.uid) ||
    text(account.email) ||
    text(account.nickname) ||
    text(account.id)
  )
}


// ---- 直接写进 magpie 的账号库 ----------------------------------------------
//
// 一次登录只能交回一个账号，所以整份导入时：选中的那个交给 magpie 自己保存，
// 其余的直接写进 plugin-auth.json —— 和 magpie 自己写的是同一个文件、同一把锁
// （plugin-auth.json.lock）、同样的键名（provider 或 provider#随机六位）。

const AUTH_FILE = "plugin-auth.json"
const LOCK_STALE_MS = 10 * 1000

function withAuthLock(directory, work) {
  const lock = join(directory, AUTH_FILE + ".lock")
  const started = Date.now()
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600))
      break
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e.code)) throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock)
          continue
        }
      } catch {}
      if (Date.now() - started > 5000) throw new Error("plugin-auth.json 正被 magpie 写入，稍后再试")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
    }
  }
  try {
    return work()
  } finally {
    try {
      unlinkSync(lock)
    } catch {}
  }
}

function authRecord(account) {
  const auth = authOf(account)
  return {
    type: "oauth",
    refresh: auth.refresh,
    access: auth.access,
    expires: auth.expires,
    accountId: nameOf(account),
    uid: auth.uid,
    domain: auth.domain,
    tokenType: auth.tokenType,
    ...(auth.refreshExpiresAt ? { refreshExpiresAt: auth.refreshExpiresAt } : {}),
    ...(auth.enterpriseId ? { enterpriseId: auth.enterpriseId } : {}),
  }
}

// addAccounts 把账号写进 magpie 的账号库，返回真正写进去的 uid。
// 已经存在的 uid 不会再写一份。
export function addAccounts(directory, accounts) {
  return withAuthLock(directory, () => {
    const path = join(directory, AUTH_FILE)
    let all = {}
    try {
      const kept = JSON.parse(readFileSync(path, "utf8"))
      if (kept && typeof kept === "object" && !Array.isArray(kept)) all = kept
    } catch {}

    const seen = new Set()
    for (const [key, value] of Object.entries(all)) {
      if (!/^(workbuddy|codebuddy)(-ai)?(#|$)/.test(key)) continue
      if (value && typeof value === "object" && value.uid) seen.add(value.uid)
    }

    const written = []
    for (const account of accounts) {
      const record = authRecord(account)
      if (record.uid && seen.has(record.uid)) continue
      const provider = PROVIDERS[variantOf(account)]
      // 永远用 provider#xxxx 这种键：登录流程里的那个账号由 magpie 自己保存，
      // 它会占掉 provider 这个裸键 —— 这里再用就会互相覆盖（实测丢过一个账号）。
      let key
      do {
        key = provider + "#" + Math.random().toString(36).slice(2, 8)
      } while (key in all)
      all[key] = record
      if (record.uid) seen.add(record.uid)
      written.push(record.uid || key)
    }

    if (written.length) writeFileSync(path, JSON.stringify(all, null, 2) + "\n")
    return written
  })
}

// 把 plugin-auth.json 里旧 provider id 的键改名（幂等）。
export function renameProviderKeys(directory, pairs) {
  return withAuthLock(directory, () => {
    const path = join(directory, AUTH_FILE)
    let all
    try {
      all = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return 0
    }
    if (!all || typeof all !== "object" || Array.isArray(all)) return 0

    const out = {}
    let moved = 0
    for (const [key, value] of Object.entries(all)) {
      let next = key
      for (const [from, to] of pairs) {
        if (key === from) {
          next = to
          moved += 1
          break
        }
        if (key.startsWith(from + "#")) {
          next = to + key.slice(from.length)
          moved += 1
          break
        }
      }
      out[next] = value
    }
    if (moved) writeFileSync(path, JSON.stringify(out, null, 2) + "\n")
    return moved
  })
}

// readAccounts 是 magpie 账号库里某个 provider 的所有账号（含带后缀的键）。
export function readAccounts(directory, provider) {
  let all
  try {
    all = JSON.parse(readFileSync(join(directory, AUTH_FILE), "utf8"))
  } catch {
    return []
  }
  if (!all || typeof all !== "object" || Array.isArray(all)) return []
  const out = []
  for (const [key, value] of Object.entries(all)) {
    if (key !== provider && !key.startsWith(provider + "#")) continue
    if (!value || typeof value !== "object") continue
    out.push({ key, auth: value })
  }
  return out
}

export { accountsFrom, authOf, keyOf, nameOf, variantOf }
