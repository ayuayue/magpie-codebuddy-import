#!/usr/bin/env node
// 把 magpie 里的 CodeBuddy 账号导出成 workbuddy-switch 的账号 JSON。
// 导入的反向：换机器、做备份、搬到另一个 magpie 都用它。
//
//   node scripts/export.mjs                 写到 Downloads/wb-switch-accounts-<日期>.json
//   node scripts/export.mjs 备份.json        写到指定文件
//   node scripts/export.mjs -               打到标准输出，自己接管道用
//
// magpie 的配置目录默认 ~/.config/magpie，可用 MAGPIE_CONFIG 指定。
// 导出的文件里有 access / refresh token，等于账号本身，别外传。

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { exportAccounts } from "../lib/accounts.mjs"

const dir = process.env.MAGPIE_CONFIG || join(homedir(), ".config", "magpie")
const accounts = exportAccounts(dir)

if (!accounts.length) {
  console.error("magpie 里没有可导出的 CodeBuddy 账号（读的是 " + join(dir, "plugin-auth.json") + "）")
  process.exit(1)
}

const cn = accounts.filter((a) => a.variant === "cn").length
const ai = accounts.length - cn
const body = JSON.stringify(accounts, null, 2) + "\n"

function stamp(at = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return at.getFullYear() + p(at.getMonth() + 1) + p(at.getDate()) + "-" + p(at.getHours()) + p(at.getMinutes())
}

// 默认落在 Downloads：import.mjs 不带参数时正好在 Downloads / 桌面里找
// wb-switch*accounts*.json，导完直接就能导回去。
function defaultPath() {
  const home = homedir()
  const first = [join(home, "Downloads"), home].find((d) => existsSync(d)) ?? home
  return join(first, "wb-switch-accounts-" + stamp() + ".json")
}

const target = process.argv[2]
if (target === "-") {
  process.stdout.write(body)
} else {
  const path = target || defaultPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, { mode: 0o600 })
  console.log("已导出 " + accounts.length + " 个账号（国内 " + cn + " / 国际 " + ai + "）")
  console.log("文件: " + path)
  console.log("里面有 access / refresh token，等于账号本身，别外传。")
}
