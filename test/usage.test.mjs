import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

import { WorkBuddyImportPlugin } from "../index.mjs"
import { beijingDay, creditsFloor, creditsOn, dayWindows, meterAsked } from "../lib/usage.mjs"
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
  assert.equal(out.count, 2, "免费模型 0 积分也是一笔，要数进去")
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
  assert.equal(w.display, "83.68 积分 · 1 笔")
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
    assert.equal(out.windows[1].display, "40.5 积分 · 2 笔")
  } finally {
    globalThis.fetch = real
    rmSync(directory, { recursive: true, force: true })
  }
})
// ---- 今日的实时下限 ----

test("汇总已用减掉流水，就是今天至少用了多少", () => {
  const directory = mkdtempSync(join(tmpdir(), "wb-floor-"))
  try {
    const at = new Date("2026-10-30T02:00:00Z").getTime() // 北京 10:00
    // 一周期已用 9075.66，流水今天 20：零点该是 9055.66，今天用了 20
    assert.equal(creditsFloor(directory, "u", 9075.66, { at, logCredit: 20 }), 20)
    assert.equal(creditsFloor(directory, "u", 9087.66, { at: at + 60_000 }), 32, "汇总又走了 12 分，不等流水")
    assert.equal(creditsFloor(directory, "u", 9000, { at: at + 120_000 }), 32, "包过期让累计倒退时，数字不跟着退")
    assert.equal(creditsFloor(directory, "u", 9100, { at: at + 180_000 }), 44.34)
    assert.equal(creditsFloor(directory, "u", 9100, { at: at + 240_000, logCredit: 0 }), 44.34, "基线只记一次")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("换一天重记基线；没有汇总就不算", () => {
  const directory = mkdtempSync(join(tmpdir(), "wb-floor-"))
  try {
    const today = new Date("2026-10-30T02:00:00Z").getTime()
    assert.equal(creditsFloor(directory, "u", 100, { at: today, logCredit: 40 }), 40)
    assert.equal(creditsFloor(directory, "u", 130, { at: today + 60_000 }), 70)
    assert.equal(creditsFloor(directory, "u", 130, { at: today + 86400_000, logCredit: 5 }), 5, "北京日换了，基线重记")
    assert.equal(creditsFloor(directory, "u", 130, { at: today + 86400_000 + 60_000 }), 5, "流水还没读通就先不算")
    assert.equal(creditsFloor(directory, "u", undefined), 0)
    assert.equal(creditsFloor(directory, "", 130), 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("流水还没封桶时，今日那行用汇总的下限顶着", async () => {
  const [w] = await dayWindows(site, AUTH, { fetchImpl: ledger(page([`${beijingDay(0)} 09:00:00`, 9.64])), floor: 15.5 })
  assert.equal(w.display, "15.5 积分 · 1 笔", "下限比流水大就用下限，次数还是流水的")

  const none = await dayWindows(site, AUTH, { fetchImpl: ledger(page()), floor: 3.2 })
  assert.equal(none[0].display, "3.2 积分", "流水里还没有，但汇总说用过了")

  const down = await dayWindows(site, AUTH, { fetchImpl: async () => { throw new Error("ETIMEDOUT") }, floor: 7 })
  assert.equal(down[0].display, "7 积分", "流水读不到也照样给出下限")

  const cold = await dayWindows(site, AUTH, { fetchImpl: async () => { throw new Error("ETIMEDOUT") }, floor: 0 })
  assert.deepEqual(cold, [], "什么都不知道就不加行")
})

test("刚用完积分：汇总动了、流水还没封桶，今日那行跟着汇总走", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wb-floor-"))
  const real = globalThis.fetch
  let used = 120
  const summary = () => json({ code: 0, data: { Packages: [{ PackageCode: "TCACA_code_008_cfWoLwvjU4", CycleTotalCapacity: "500", CycleUsedCapacity: String(used), CycleRemainCapacity: "380" }], SubscriptionPackageCode: "" } })
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.endsWith("/billing/meter/get-user-request-usage")) return json(page([`${beijingDay(0)} 09:00:00`, 40.5]))
    if (u.endsWith("/get-user-resource-summary")) return summary()
    return json({ code: 0, data: { Accounts: [], TotalCount: 0 } })
  }
  globalThis.fetch = fetchImpl
  try {
    const hooks = await WorkBuddyImportPlugin({
      client: { auth: { set: async () => {}, remove: async () => {} }, app: { log: () => {} } },
      directory,
      magpie: { option: () => undefined },
      fetchImpl,
    })
    const first = await hooks.auth.usage(async () => AUTH)
    assert.equal(first.windows[1].display, "40.5 积分 · 1 笔", "第一次读只记基线")

    used = 126 // 又用了 6 分，流水还是那一桶
    const second = await hooks.auth.usage(async () => AUTH)
    assert.equal(second.windows[1].display, "46.5 积分 · 1 笔", "不等封桶，跟着汇总先到 46.5")

    used = 100 // 包过期，累计倒退
    const third = await hooks.auth.usage(async () => AUTH)
    assert.equal(third.windows[1].display, "46.5 积分 · 1 笔", "倒退不往回跳")
  } finally {
    globalThis.fetch = real
    rmSync(directory, { recursive: true, force: true })
  }
})
