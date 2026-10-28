#!/usr/bin/env node
// 猫猫旅行的开关与状态，直接在命令行管，不必去界面上找开关。
//
//   node scripts/travel.mjs on        打开（等价于界面上那份开关）
//   node scripts/travel.mjs off       关闭
//   node scripts/travel.mjs status    看每个账号今天的派发/领奖状态
//   node scripts/travel.mjs run       立刻跑一轮（派发 + 领奖），不用等 15 分钟
//
// magpie 的配置目录默认 ~/.config/magpie，可用 MAGPIE_CONFIG 指定。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { runTravel } from "../lib/travel.mjs"

const dir = process.env.MAGPIE_CONFIG || join(homedir(), ".config", "magpie")
const marker = join(dir, "travel-on")
const statePath = join(dir, "travel-state.json")
const cmd = (process.argv[2] || "status").toLowerCase()

function state() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    return null
  }
}

function say(what) {
  console.log(what)
}

if (cmd === "on") {
  mkdirSync(dir, { recursive: true })
  writeFileSync(marker, "")
  say("已打开猫猫旅行：" + marker)
  say("（删除这个文件就是关闭；改完不用重启，下一轮就生效）")
} else if (cmd === "off") {
  rmSync(marker, { force: true })
  say("已关闭猫猫旅行")
} else if (cmd === "run") {
  const acted = await runTravel({ directory: dir, provider: "codebuddy", dispatch: true, travelOn: true, marker: true })
  say("本轮动作 " + acted + " 个，详见 " + statePath)
} else if (cmd === "status") {
  const st = state()
  say("开关 " + (readable() ? "已打开" : "未打开") + "（" + marker + "）")
  if (!st) {
    say("还没有记录（" + statePath + "）。先 node scripts/travel.mjs on，然后 run 一轮。")
    process.exit(0)
  }
  say("日期 " + st.date)
  for (const [uid, e] of Object.entries(st.accounts || {})) {
    const bits = []
    if (e.dispatched) bits.push("已派出" + (e.location ? "→" + e.location : ""))
    if (e.traveling) bits.push("旅行中")
    if (e.claimed) bits.push("已领奖" + (e.reward != null ? " +" + e.reward : ""))
    if (e.done) bits.push("今日完成")
    if (e.skip) bits.push("跳过:" + e.skip)
    say("  " + uid + "  " + (bits.join(" · ") || "未动"))
  }
  if (st.log?.length) {
    say("最近日志：")
    for (const line of st.log.slice(-8)) say("  " + line)
  }
} else {
  say("用法: node scripts/travel.mjs on|off|status|run")
}

function readable() {
  try {
    readFileSync(marker)
    return true
  } catch {
    return false
  }
}
