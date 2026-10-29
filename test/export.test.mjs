import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import assert from "node:assert/strict"

import { accountsFrom, addAccounts, authOf, exportAccounts, nameOf, variantOf } from "../lib/accounts.mjs"

const directory = mkdtempSync(join(tmpdir(), "wb-export-"))
after(() => rmSync(directory, { recursive: true, force: true }))

const cn = {
  uid: "uid-cn",
  nickname: "国内号",
  variant: "cn",
  domain: "www.codebuddy.cn",
  access_token: "at-cn",
  refresh_token: "rt-cn",
  token_type: "Bearer",
  expiresAt: 1900000000000,
  refreshExpiresAt: 1910000000000,
}

const ai = {
  uid: "uid-ai",
  nickname: "国际号",
  variant: "ai",
  domain: "www.workbuddy.ai",
  access_token: "at-ai",
  refresh_token: "rt-ai",
  expiresAt: 1920000000000,
}

test("导出的账号能原样再导入", () => {
  addAccounts(directory, [cn, ai])
  const out = exportAccounts(directory)

  assert.equal(out.length, 2)
  const got = new Map(out.map((a) => [a.uid, a]))
  assert.equal(variantOf(got.get("uid-cn")), "cn")
  assert.equal(variantOf(got.get("uid-ai")), "ai")
  assert.equal(got.get("uid-cn").access_token, "at-cn")
  assert.equal(got.get("uid-cn").refresh_token, "rt-cn")
  assert.equal(got.get("uid-cn").refreshExpiresAt, 1910000000000)
  assert.equal(got.get("uid-ai").domain, "www.workbuddy.ai")
  assert.equal(got.get("uid-cn").token_type, "Bearer")

  // 导出的 JSON 再走一遍解析，字段该一模一样
  const again = accountsFrom(JSON.stringify(out))
  assert.equal(again.length, 2)
  const cn2 = again.find((a) => authOf(a).uid === "uid-cn")
  assert.equal(authOf(cn2).access, "at-cn")
  assert.equal(authOf(cn2).refresh, "rt-cn")
  assert.equal(authOf(cn2).expires, 1900000000000)
  assert.equal(nameOf(cn2), "国内号")
})

test("只导 codebuddy 系的 oauth 账号", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-export-mix-"))
  after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, "plugin-auth.json"),
    JSON.stringify({
      "codebuddy#aaa": { type: "oauth", access: "a1", refresh: "r1", uid: "u1", accountId: "号一", domain: "www.codebuddy.cn" },
      "codebuddy-ai#bbb": { type: "oauth", access: "a2", refresh: "r2", uid: "u2", accountId: "号二", domain: "www.workbuddy.ai" },
      "codebuddy#ccc": { type: "api", key: "sk-secret" },
      "codebuddy#ddd": {},
      "qoder-cn#eee": { type: "oauth", access: "a3", refresh: "r3", uid: "u3" },
      "codebuddy": { type: "oauth", access: "a4", uid: "u4", accountId: "裸键" },
    }),
  )

  const out = exportAccounts(dir)
  assert.deepEqual(
    out.map((a) => a.uid),
    ["u1", "u4", "u2"],
  )
  assert.equal(out.filter((a) => a.access_token === "a3").length, 0)
  assert.equal(JSON.stringify(out).includes("sk-secret"), false)
  // 没有 domain 时按档位补上默认值
  assert.equal(out.find((a) => a.uid === "u4").domain, "www.codebuddy.cn")
  assert.equal(out.find((a) => a.uid === "u4").refresh_token, "")
})
