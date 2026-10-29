import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

import { WorkBuddyImportPlugin } from "../index.mjs"
import { beijingDay, creditsOn, dayWindows, meterAsked } from "../lib/usage.mjs"
import { _internal } from "../vendor/opencode-workbuddy-auth.mjs"

const site = _internal.SITES.workbuddy
const AUTH = { type: "oauth", access: "at", refresh: "rt", expires: 1900000000000, uid: "u", domain: "workbuddy.cn" }

// 实测形状（2026-10-29 copilot.tencent.com 的 get-user-request-usage）：
// data.data[] 每笔 { requestId, credit, model, client, requestTime "YYYY-MM-DD HH:mm:ss"（北京时间） }
const page = (...pairs) => ({ code: 0, data: { total: pairs.length, data: pairs.map(([requestTime, credit]) => ({ requestId: requestTime + credit, credit, requestTime })) } })
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

function ledger(...pages) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    return json(pages.shift() ?? page())
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const DAY = "2026-10-29"

test("按北京日聚合当天流水，请求头与用量那条一致", async () => {
  const fetchImpl = ledger(
    page([`${DAY} 09:12:30`, 12.5], [`${DAY} 08:00:00`, 0]),
    page(),
  )
  const out = await creditsOn(site, AUTH, { day: DAY, fetchImpl })
  assert.equal(out.credit, 12.5)
  assert.equal(out.count, 2, "免费模型 0 积分也是一次请求，要数进去")
  assert.equal(out.capped, false)
  const body = fetchImpl.calls[0].body
  assert.deepEqual([body.startTime, body.endTime], [`${DAY} 00:00:00`, `${DAY} 23:59:59`], "只查一天：范围查询会把跨午夜的行重分到两边")
  assert.equal(body.pageSize, 200)
  assert.equal(fetchImpl.calls[0].headers["user-agent"], "WorkBuddy/" + site.app)
  assert.equal(fetchImpl.calls[0].headers["x-product"], "SaaS")
  assert.equal(fetchImpl.calls[0].headers["x-domain"], "workbuddy.cn")
})

test("翻页到上限时说不精确，时间认不出的行丢掉", async () => {
  const full = () => page(...Array.from({ length: 200 }, (_, i) => [`${DAY} 10:00:00`, 1]))
  const capped = await creditsOn(site, AUTH, { day: DAY, fetchImpl: ledger(...Array.from({ length: 12 }, full)) })
  assert.equal(capped.capped, true)
  assert.equal(capped.credit, 2000)

  const messy = await creditsOn(site, AUTH, {
    day: DAY,
    fetchImpl: ledger(page(["not-a-time", 5], [`${DAY} 10:00:00`, "7.25"], [`${DAY} 11:00:00`, null], ["2026-10-28 23:59:59", 99]), page()),
  })
  assert.equal(messy.credit, 7.25, "credit 是数字字符串时认；null 按 0 算；别的日子与坏时间不算进来")
  assert.equal(messy.count, 2)
})

test("卡片上是今日一行真数，且只作展示", async () => {
  const fetchImpl = ledger(page([`${beijingDay(0)} 09:00:00`, 83.68]), page())
  const [w] = await dayWindows(site, AUTH, { fetchImpl })
  assert.equal(w.name, "今日")
  assert.equal(w.display, "83.68 积分 · 1 次请求")
  assert.equal(w.aside, true)
  // 不给 used/amount/limit：magpie 就当文本行，既不参与按天差分，也不给路由报
  // 额度 —— 一周期已用是几十个滚动包加总、随时会倒退，不能当基线
  assert.equal(w.used, undefined)
  assert.equal(w.amount, undefined)
  assert.equal(w.limit, undefined)
})

test("今天没用过就说今天没用过，读不到流水时不加行", async () => {
  const quiet = await dayWindows(site, AUTH, { fetchImpl: ledger(page()) })
  assert.equal(quiet[0].display, "今天还没有请求")

  const broken = await dayWindows(site, AUTH, {
    fetchImpl: async () => new Response(JSON.stringify({ code: 10001, msg: "invalid params" }), { status: 400 }),
  })
  assert.deepEqual(broken, [], "流水读不到不该把用量卡片一起弄挂")

  const down = await dayWindows(site, AUTH, { fetchImpl: async () => { throw new Error("ETIMEDOUT") } })
  assert.deepEqual(down, [])
})

test("meterAsked 把 WorkBuddy 的错误码说成错误", async () => {
  await assert.rejects(
    () => meterAsked(site, AUTH, "/billing/meter/get-user-resource-summary", {}, async () =>
      new Response(JSON.stringify({ code: 14018, msg: "Credits exhausted" }), { status: 200 })),
    /Credits exhausted/,
  )
})

// ---- 挂到 auth.usage 上 ----

function providerFetch() {
  const pages = [page([`${beijingDay(0)} 09:00:00`, 40.5], [`${beijingDay(0)} 09:30:00`, 0]), page()]
  return async (url) => {
    const u = String(url)
    if (u.endsWith("/billing/meter/get-user-request-usage")) return json(pages.shift() ?? page())
    if (u.endsWith("/get-user-resource-summary")) {
      return json({ code: 0, data: { Packages: [{ PackageCode: "TCACA_code_008_cfWoLwvjU4", CycleTotalCapacity: "500", CycleUsedCapacity: "120", CycleRemainCapacity: "380" }], SubscriptionPackageCode: "" } })
    }
    return json({ code: 0, data: { Accounts: [], TotalCount: 0 } })
  }
}

test("用量卡片在原来的一周期窗口后面补上今日一行", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wb-usage-"))
  // 上游那份 usage 用的是全局 fetch（不吃 input.fetchImpl），所以这里换掉全局的
  const real = globalThis.fetch
  globalThis.fetch = providerFetch()
  try {
    const hooks = await WorkBuddyImportPlugin({
      client: { auth: { set: async () => {}, remove: async () => {} }, app: { log: () => {} } },
      directory,
      magpie: { option: () => undefined },
    })
    const out = await hooks.auth.usage(async () => AUTH)
    assert.equal(out.error, undefined)
    assert.equal(out.windows[0].name, "Credits")
    assert.equal(out.windows[0].amount, 120, "上游那个一周期窗口原样保留（进度条和路由还靠它）")
    assert.deepEqual(out.windows.slice(1).map((w) => w.name), ["今日"])
    assert.equal(out.windows[1].display, "40.5 积分 · 2 次请求")
  } finally {
    globalThis.fetch = real
    rmSync(directory, { recursive: true, force: true })
  }
})
