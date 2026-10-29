#!/usr/bin/env node
// 猫猫旅行的开关、状态和手动执行，都在命令行里，不必去界面上找开关。
//
//   node scripts/travel.mjs run      立刻跑一轮（派发 + 领奖），不看开关
//   node scripts/travel.mjs status   开关状态 + 每个账号今天的进度
//   node scripts/travel.mjs on       打开自动跑
//   node scripts/travel.mjs off      关闭自动跑
//
// magpie 的配置目录默认 ~/.config/magpie，可用 MAGPIE_CONFIG 指定。
// 装进 magpie 之后脚本在
//   ~/.config/magpie/plugins/node_modules/magpie-codebuddy-import/scripts/travel.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { readAccounts } from "../lib/accounts.mjs"
import { beijingDay, runTravel } from "../lib/travel.mjs"

const dir = process.env.MAGPIE_CONFIG || join(homedir(), ".config", "magpie")
const marker = join(dir, "travel-on")
const statePath = join(dir, "travel-state.json")
const settingsPath = join(dir, "settings.json")
const provider = "codebuddy"
const cmd = (process.argv[2] || "status").toLowerCase()
const USAGE = "用法: node scripts/travel.mjs run|status|on|off"

// 状态文件里的跳过原因，翻成人话
const SKIPS = {
  "no-token": "没有可用登录",
  "token-expired": "token 过期，等 magpie 续期",
  "daily-limit": "今天次数用完",
  "no-location": "没有可选目的地",
  unauthorized: "登录失效，重新登录",
}

function say(what) {
  console.log(what)
}

function exists(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

// 界面上的开关，存在 settings.json 的 pluginOptions.codebuddy.travel。
// 这里只读不写：magpie 正在跑的时候改它，可能被它内存里的副本盖回去。
function optionOn() {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"))?.pluginOptions?.[provider]?.travel === true
  } catch {
    return false
  }
}

function state() {
  try {
    const kept = JSON.parse(readFileSync(statePath, "utf8"))
    return kept && typeof kept === "object" ? kept : null
  } catch {
    return null
  }
}

// 账号库里的显示名：状态文件按 uid 记，人看不懂
function accounts() {
  return readAccounts(dir, provider).map(({ key, auth }) => ({
    uid: auth.uid || key,
    name: auth.accountId || auth.uid || key,
    expired: typeof auth.expires === "number" && auth.expires > 0 && auth.expires < Date.now(),
  }))
}

// 日志行是 ISO 时间 + uid，换成北京时间和账号名
function bjTime(iso) {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const d = new Date(at + 8 * 3600_000)
  const two = (n) => String(n).padStart(2, "0")
  return two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) + " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes())
}

function tidy(line, names) {
  let out = line
  const m = /^(\S+Z)\s(.*)$/.exec(line)
  if (m) out = bjTime(m[1]) + " " + m[2]
  for (const [uid, name] of names) {
    if (!out.includes(uid)) continue
    out = out.replace(uid, name)
    break
  }
  return out
}

function describe(entry) {
  if (entry.done) return "今日收工" + (entry.skip ? "（" + (SKIPS[entry.skip] ?? entry.skip) + "）" : "")
  const bits = []
  if (entry.dispatched) bits.push("已派出" + (entry.location ? "→" + entry.location : ""))
  if (entry.traveling) bits.push("旅行中")
  if (entry.claimed) bits.push("已领奖" + (entry.reward != null ? " +" + entry.reward : ""))
  if (entry.skip) bits.push("跳过:" + (SKIPS[entry.skip] ?? entry.skip))
  return bits.join(" · ") || "未动"
}

// 把今天的进度摊开：状态文件里的账号 + 账号库里还没跑过的
function show() {
  const st = state()
  const list = accounts()
  const names = new Map(list.map((a) => [a.uid, a.name]))
  const rows = Object.entries(st?.accounts ?? {})
  if (!rows.length && !list.length) {
    say("还没有账号，也没有记录。先在 magpie 里登录 CodeBuddy。")
    return
  }
  if (st?.date) {
    const stale = st.date !== beijingDay() ? "（不是今天的，下一轮会自动重置）" : ""
    say("今天 " + st.date + stale)
  }
  for (const [uid, entry] of rows) say("  " + (names.get(uid) ?? uid) + "  " + describe(entry))
  for (const a of list) {
    if (a.uid in (st?.accounts ?? {})) continue
    say("  " + a.name + "  " + (a.expired ? SKIPS["token-expired"] : "今天还没跑"))
  }
  if (st?.log?.length) {
    say("最近日志：")
    for (const line of st.log.slice(-6)) say("  " + tidy(line, names))
  }
}

if (cmd === "on") {
  mkdirSync(dir, { recursive: true })
  writeFileSync(marker, "")
  say("已打开自动派猫猫旅行：" + marker)
  say("下一轮就生效，不用重启。关掉：node scripts/travel.mjs off")
} else if (cmd === "off") {
  rmSync(marker, { force: true })
  if (optionOn()) {
    say("已删掉 travel-on，但界面上的开关还开着（settings.json 里 pluginOptions." + provider + ".travel=true），自动跑不会停。")
    say("去 Providers 页展开 CodeBuddy 那一行，取消「自动派猫猫旅行」。")
  } else {
    say("已关闭自动派猫猫旅行。")
  }
} else if (cmd === "run") {
  const list = accounts()
  if (!list.length) {
    say("账号库里没有国内版（codebuddy）账号，先在 magpie 里登录再跑。")
    process.exitCode = 1
  } else {
    const names = new Map(list.map((a) => [a.uid, a.name]))
    say("手动跑一轮（派发 + 领奖，不看开关），" + list.length + " 个账号：")
    const acted = await runTravel({
      directory: dir,
      provider,
      dispatch: true,
      travelOn: true,
      marker: true,
      log: (line) => say("  " + tidy(line, names)),
    })
    say("本轮动作 " + acted + " 个" + (acted ? "" : "（今天该做的都做完了，或暂时跳过）"))
    say("")
    show()
  }
} else if (cmd === "status") {
  const opt = optionOn()
  const mark = exists(marker)
  say("自动派猫猫旅行：" + (opt || mark ? "开" : "关"))
  say("  界面开关 " + (opt ? "开" : "关") + "（settings.json 的 pluginOptions." + provider + ".travel）")
  say("  travel-on " + (mark ? "有" : "无") + "（" + marker + "）")
  say("")
  show()
  if (!opt && !mark) say("\n想手动跑一轮：node scripts/travel.mjs run")
} else {
  say(USAGE)
}
