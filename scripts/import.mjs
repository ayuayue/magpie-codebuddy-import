#!/usr/bin/env node
// 批量把 workbuddy-switch 导出的账号导入 magpie。
//
//   node scripts/import.mjs "C:\\path\\to\\wb-accounts.json"
//
// 走的是 magpie 自己的 `plugin login` 命令（和界面上「导入账号 JSON」同一个入口），
// 所以账号存在 magpie 该在的地方，也不碰任何状态文件。

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { accountsFrom, nameOf, variantOf } from "../lib/accounts.mjs"

const PROVIDERS = { cn: "workbuddy", ai: "workbuddy-ai" }
const METHOD = "导入账号 JSON"

function magpie() {
  const set = process.env.MAGPIE_CLI
  if (set) return set
  const local = join(homedir(), "Downloads", "magpie.cmd")
  if (process.platform === "win32" && existsSync(local)) return local
  return "magpie"
}

function run(args, input) {
  // .cmd 需要经过 cmd.exe；不用 shell:true，免得 Node 的 shell 参数转义告警
  const bin = magpie()
  const win = process.platform === "win32"
  const r = win
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", bin, ...args], { input, encoding: "utf8" })
    : spawnSync(bin, args, { input, encoding: "utf8" })
  return { code: r.status ?? -1, out: (r.stdout || "") + (r.stderr || "") }
}

// 登录方式的编号由插件自己排，问一次菜单最稳。
function methodIndex(provider) {
  const { out } = run(["plugin", "login", provider], "999\n")
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\.\s*(.+)$/)
    if (m && m[2].includes(METHOD)) return Number(m[1])
  }
  return -1
}

// 不带参数时，取 Downloads / 桌面里最新的 wb-switch-accounts*.json
function newestExport() {
  let best = null
  for (const dir of [join(homedir(), "Downloads"), join(homedir(), "Desktop")]) {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/^wb-switch.*accounts.*\.json$/i.test(name)) continue
      const path = join(dir, name)
      try {
        const at = statSync(path).mtimeMs
        if (!best || at > best.at) best = { path, at }
      } catch {}
    }
  }
  return best?.path
}

const file = process.argv[2] || newestExport()
if (!file) {
  console.error("用法: node scripts/import.mjs [账号.json]")
  console.error("不带文件时会在 Downloads / 桌面里找最新的 wb-switch-accounts*.json")
  process.exit(2)
}
console.log("文件: " + file)

const accounts = accountsFrom(readFileSync(file, "utf8"))
console.log("读到 " + accounts.length + " 个账号")

const groups = new Map()
for (const account of accounts) {
  const provider = PROVIDERS[variantOf(account)]
  if (!groups.has(provider)) groups.set(provider, [])
  groups.get(provider).push(account)
}

let ok = 0
let skipped = 0
for (const [provider, list] of groups) {
  const index = methodIndex(provider)
  if (index < 0) {
    console.log(provider + ": 找不到「" + METHOD + "」这个登录方式，插件装了吗？")
    continue
  }
  for (const account of list) {
    const name = nameOf(account)
    const { code, out } = run(["plugin", "login", provider], index + "\n" + JSON.stringify(account) + "\n")
    if (code === 0 && /signed in/.test(out)) {
      ok += 1
      console.log("  ✓ " + provider + "  " + name)
    } else {
      skipped += 1
      const why = (out.split(/\r?\n/).filter(Boolean).pop() || "没有输出")
        .replace(/^Code:\s*/, "")
        .replace(/^magpie: the sign-in failed:\s*/, "")
        .replace(/^magpie: /, "")
      console.log("  - " + provider + "  " + name + "  " + (/都导入过了/.test(why) ? "已经在 magpie 里，跳过" : why))
    }
  }
}

console.log("完成：导入 " + ok + " 个，跳过 " + skipped + " 个")
if (ok) console.log("magpie 正在运行的话，重启一下才能在界面上看到新账号。")
