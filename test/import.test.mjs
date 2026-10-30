import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import assert from "node:assert/strict"

import { WorkBuddyAIImportPlugin, WorkBuddyImportPlugin } from "../index.mjs"

const directory = mkdtempSync(join(tmpdir(), "wb-import-"))
after(() => rmSync(directory, { recursive: true, force: true }))

const client = { auth: { set: async () => {} }, app: { log: () => {} } }

async function methodsOf(factory) {
  const hooks = await factory({ client, directory, magpie: { option: () => undefined } })
  return hooks.auth.methods
}

const cn = {
  id: "a",
  uid: "uid-cn",
  nickname: "国内号",
  email: "cn@example.com",
  access_token: "at-cn",
  refresh_token: "rt-cn",
  token_type: "Bearer",
  domain: "workbuddy.cn",
  variant: "cn",
  expiresAt: 1900000000000,
  refreshExpiresAt: 1910000000000,
}

const ai = {
  uid: "uid-ai",
  nickname: "国际号",
  access_token: "at-ai",
  refresh_token: "rt-ai",
  domain: "www.workbuddy.ai",
  expiresAt: 1900000000000,
}

async function importOnce(factory, payload) {
  const methods = await methodsOf(factory)
  const method = methods.find((m) => m.label.includes("导入账号 JSON"))
  assert.ok(method, "导入口没有挂到 methods 上")
  const flow = await method.authorize()
  assert.equal(flow.method, "code")
  return flow.callback(typeof payload === "string" ? payload : JSON.stringify(payload))
}

test("导入国内版账号：字段映射到 magpie 的 oauth 形状", async () => {
  const out = await importOnce(WorkBuddyImportPlugin, cn)
  assert.equal(out.type, "success")
  assert.equal(out.access, "at-cn")
  assert.equal(out.refresh, "rt-cn")
  assert.equal(out.uid, "uid-cn")
  assert.equal(out.accountId, "国内号")
  assert.equal(out.expires, 1900000000000)
  assert.equal(out.refreshExpiresAt, 1910000000000)
})

test("整份导出数组一次只导入一个，重复粘贴导入下一个", async () => {
  const first = await importOnce(WorkBuddyImportPlugin, [cn, { ...cn, uid: "uid-cn-2", nickname: "第二个号" }])
  assert.equal(first.type, "success")
  assert.equal(first.accountId, "第二个号")

  const again = await importOnce(WorkBuddyImportPlugin, [cn, { ...cn, uid: "uid-cn-2", nickname: "第二个号" }])
  assert.equal(again.type, "failed")
  assert.match(again.error, /都导入过了/)
})

test("国际版账号只认 WorkBuddy AI 的导入口", async () => {
  const wrong = await importOnce(WorkBuddyImportPlugin, ai)
  assert.equal(wrong.type, "failed")
  assert.match(wrong.error, /没有 CodeBuddy 的账号/)

  const right = await importOnce(WorkBuddyAIImportPlugin, ai)
  assert.equal(right.type, "success")
  assert.equal(right.uid, "uid-ai")
})

test("加密信封 token 明确拒绝", async () => {
  const sealed = { ...cn, uid: "uid-sealed", access_token: { $wbEncrypted: 1, envelope: "x" } }
  const out = await importOnce(WorkBuddyImportPlugin, sealed)
  assert.equal(out.type, "failed")
  assert.match(out.error, /加密信封/)
})

test("不是 JSON 时说清楚", async () => {
  const out = await importOnce(WorkBuddyImportPlugin, "not json")
  assert.equal(out.type, "failed")
  assert.match(out.error, /不是合法 JSON/)
})

test("兼容 camelCase 与 auth_raw.auth 嵌套写法", async () => {
  const nested = {
    uid: "uid-nested",
    nickname: "嵌套号",
    variant: "cn",
    expiresIn: 3600,
    auth_raw: { auth: { accessToken: "at-nested", refreshToken: "rt-nested", domain: "workbuddy.cn" } },
  }
  const out = await importOnce(WorkBuddyImportPlugin, { accounts: [nested] })
  assert.equal(out.type, "success")
  assert.equal(out.access, "at-nested")
  assert.equal(out.refresh, "rt-nested")
  assert.equal(out.domain, "workbuddy.cn")
  assert.ok(out.expires > Date.now())
})

test("整份导出一次导入完：一个交给 magpie，其余直接写进账号库", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-bulk-"))
  try {
    const hooks = await WorkBuddyImportPlugin({ client, directory: dir, magpie: { option: () => undefined } })
    const method = hooks.auth.methods.find((m) => m.label.includes("导入账号 JSON"))
    const flow = await method.authorize()

    const list = [
      { uid: "b1", nickname: "批量一", access_token: "t1", refresh_token: "r1", variant: "cn", domain: "workbuddy.cn", expiresAt: 1900000000000 },
      { uid: "b2", nickname: "批量二", access_token: "t2", refresh_token: "r2", variant: "cn", domain: "workbuddy.cn", expiresAt: 1900000000000 },
      { uid: "b3", nickname: "批量三", access_token: "t3", refresh_token: "r3", variant: "ai", domain: "www.workbuddy.ai", expiresAt: 1900000000000 },
    ]

    const out = await flow.callback(JSON.stringify(list))
    assert.equal(out.type, "success")
    assert.equal(out.accountId, "批量一")

    const store = JSON.parse(readFileSync(join(dir, "plugin-auth.json"), "utf8"))
    assert.deepEqual(Object.values(store).map((v) => v.uid).sort(), ["b2", "b3"])
    // 键一律带后缀，避开登录流程占用的裸键 provider；对外 id 是 codebuddy 系
    assert.ok(Object.keys(store).every((k) => /^codebuddy(-ai)?#[a-z0-9]{6}$/.test(k)))
    const intl = Object.values(store).find((v) => v.uid === "b3")
    assert.equal(intl.type, "oauth")
    assert.equal(intl.access, "t3")

    const again = await flow.callback(JSON.stringify(list))
    assert.equal(again.type, "failed")
    assert.match(again.error, /都导入过了/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("旧 workbuddy 键在插件加载时迁到 codebuddy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-mig-"))
  try {
    writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
      workbuddy: { type: "oauth", access: "a", refresh: "r", uid: "m1", accountId: "旧一号" },
      "workbuddy#abc123": { type: "oauth", access: "a", refresh: "r", uid: "m2", accountId: "旧二号" },
      "workbuddy-ai": { type: "oauth", access: "a", refresh: "r", uid: "m3", accountId: "旧国际" },
      cline: { type: "api", key: "k" },
    }))
    // magpie 会把每个导出的工厂都实例化，两个档位各自迁各自的键
    await WorkBuddyImportPlugin({ client, directory: dir, magpie: { option: () => undefined } })
    await WorkBuddyAIImportPlugin({ client, directory: dir, magpie: { option: () => undefined } })
    const store = JSON.parse(readFileSync(join(dir, "plugin-auth.json"), "utf8"))
    assert.deepEqual(Object.keys(store), ["codebuddy", "codebuddy#abc123", "codebuddy-ai", "cline"])
    assert.equal(store.codebuddy.uid, "m1")
    assert.equal(store["codebuddy-ai"].uid, "m3")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 签到 ----

function stubFetch(responses) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (!next) throw new Error("没有更多桩响应")
    return typeof next === "function" ? next(url, init, calls) : next
  }
  fetch.calls = calls
  return fetch
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function checkinHook(fetchImpl) {
  const dir = mkdtempSync(join(tmpdir(), "wb-checkin-"))
  const hooks = await WorkBuddyImportPlugin({ client, directory: dir, magpie: { option: () => undefined }, fetchImpl })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(hooks.auth.provider, "codebuddy")
  return hooks.auth
}

const AUTH = { type: "oauth", access: "at", refresh: "rt", expires: 1900000000000, uid: "u", domain: "workbuddy.cn" }

test("签到：活动进行中且未签 → 领取", async () => {
  const fetch = stubFetch([
    json({ code: 0, data: { active: true, todayCheckedIn: false } }),
    json({ code: 0, data: { credit: 50, streakDays: 3, message: "签到成功" } }),
  ])
  const auth = await checkinHook(fetch)
  const out = await auth.checkin(async () => AUTH)
  assert.equal(out.outcome, "claimed")
  assert.equal(out.credit, 50)
  assert.equal(out.streak, 3)
  assert.equal(fetch.calls[0].url, "https://copilot.tencent.com/v2/billing/meter/checkin-activity-status")
  assert.equal(fetch.calls[1].url, "https://copilot.tencent.com/v2/billing/meter/daily-checkin")
  assert.equal(fetch.calls[1].init.headers.authorization, "Bearer at")
  assert.equal(fetch.calls[1].init.headers["x-user-id"], "u")
  // 真领到了才说这个答案到下一个北京零点为止
  const until = Date.parse(out.until)
  assert.ok(until > Date.now() && until - Date.now() <= 24 * 3600_000)
  assert.equal(new Date(until + 8 * 3600_000).toISOString().slice(11, 19), "00:00:00")
})

test("签到：今天已签 / 活动未开始 / 已结束", async () => {
  const auth = await checkinHook(stubFetch([json({ code: 0, data: { active: true, todayCheckedIn: true, todayCredit: 20, streakDays: 9 } })]))
  assert.equal((await auth.checkin(async () => AUTH)).outcome, "done")

  const hook2 = await checkinHook(stubFetch([json({ code: 0, data: { active: false } })]))
  assert.equal((await hook2.checkin(async () => AUTH)).outcome, "inactive")

  const hook3 = await checkinHook(stubFetch([
    json({ code: 0, data: { active: true, todayCheckedIn: false } }),
    json({ code: 1003, msg: "活动已结束" }),
  ]))
  const out = await hook3.checkin(async () => AUTH)
  assert.equal(out.outcome, "inactive")
  assert.match(out.message, /结束/)
})

test("签到：重复签返回 done", async () => {
  const auth = await checkinHook(stubFetch([
    json({ code: 0, data: { active: true, todayCheckedIn: false } }),
    json({ code: 1001, msg: "今天已签到" }),
  ]))
  assert.equal((await auth.checkin(async () => AUTH)).outcome, "done")
})

// WorkBuddy 的签到接口返回的是 snake_case（实测 2026-10-29 四个国内账号）。
// 早前只读 camelCase，等于每个已签的账号都被当成没签，转去调 claim。
test("签到：认 snake_case 的真实返回，且已签就不再调 claim", async () => {
  const fetch = stubFetch([
    json({ code: 0, data: { active: true, today_checked_in: true, today_credit: 100, streak_days: 30 } }),
  ])
  const auth = await checkinHook(fetch)
  const out = await auth.checkin(async () => AUTH)
  assert.equal(out.outcome, "done")
  assert.equal(out.credit, 100)
  assert.equal(out.streak, 30)
  assert.equal(fetch.calls.length, 1, "已签的账号不该再去调 claim")
  // 没真领到就不给 until：magpie 只有在 until 为空时才会把「已签到」当成可能是
  // 昨天的，每 30 分钟再问一次，过了中午那句话才会消失
  assert.equal(out.until, undefined)
})

test("签到：claim 被「今天已签到」顶回来（10001）算已签，不是一天的失败", async () => {
  // 回归：10001 是 WorkBuddy 的通用错误码，早前不认识它就把成功报成 failed，
  // magpie 于是把「今天已签到，请明天再来」挂在卡片上一整天。
  const auth = await checkinHook(stubFetch([
    json({ code: 0, data: { active: true, today_checked_in: false, streak_days: 29 } }),
    new Response(JSON.stringify({ code: 10001, msg: "今天已签到，请明天再来" }), { status: 400 }),
  ]))
  const out = await auth.checkin(async () => AUTH)
  assert.equal(out.outcome, "done")
  assert.equal(out.streak, 29)
})

test("签到：状态接口说没开始时不调 claim", async () => {
  const fetch = stubFetch([json({ code: 0, data: { active: false, today_checked_in: false } })])
  const auth = await checkinHook(fetch)
  const out = await auth.checkin(async () => AUTH)
  assert.equal(out.outcome, "inactive")
  assert.equal(fetch.calls.length, 1, "不该多发一次 claim 请求")
})

test("签到：401 但额度读得动 → 提示去 App 里签", async () => {
  const auth = await checkinHook(stubFetch([
    new Response("gateway", { status: 401 }),
    json({ code: 0, data: {} }),
  ]))
  const out = await auth.checkin(async () => AUTH)
  assert.equal(out.outcome, "inactive")
  assert.match(out.message, /App/)
})

test("签到：401 且额度也读不动 → 登录失效", async () => {
  const auth = await checkinHook(stubFetch([
    new Response("", { status: 401 }),
    new Response("", { status: 401 }),
  ]))
  await assert.rejects(() => auth.checkin(async () => AUTH), /重新登录/)
})

// ---- 派猫猫旅行 ----

import { runTravel } from "../lib/travel.mjs"

function travelDir() {
  const dir = mkdtempSync(join(tmpdir(), "wb-travel-"))
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
    codebuddy: { type: "oauth", access: "at", refresh: "rt", expires: 1900000000000, uid: "cat-1", domain: "workbuddy.cn" },
  }))
  return dir
}

function travelState(dir) {
  return JSON.parse(readFileSync(join(dir, "travel-state.json"), "utf8"))
}

test("旅行：idle 且开关打开 → 派发（取第一个地点）", async () => {
  const dir = travelDir()
  const fetch = stubFetch([
    json({ code: 0, data: { state: "idle", daily_limit_reached: false } }),
    json({ code: 0, data: { enabled: true, locations: [{ id: 7, name: "成都" }, { id: 9, name: "西安" }] } }),
    json({ code: 0, data: { state: "traveling" } }),
  ])
  const acted = await runTravel({ directory: dir, provider: "codebuddy", dispatch: true, travelOn: true, fetchImpl: fetch })
  assert.equal(acted, 1)
  // depart 带的 location_id 是地点列表第一个
  assert.equal(JSON.parse(fetch.calls[2].init.body).location_id, 7)
  const st = travelState(dir)
  assert.equal(st.accounts["cat-1"].dispatched, true)
  assert.equal(st.accounts["cat-1"].location, "成都")
  assert.match(st.log.join("\n"), /派出/)
  rmSync(dir, { recursive: true, force: true })
})

test("旅行：开关关着 / 非派发轮 → 不派", async () => {
  const dir = travelDir()
  const fetch = stubFetch([json({ code: 0, data: { state: "idle", daily_limit_reached: false } })])
  const acted = await runTravel({ directory: dir, provider: "codebuddy", dispatch: true, travelOn: false, fetchImpl: fetch })
  assert.equal(acted, 0)
  assert.equal(fetch.calls.length, 1)

  const dir2 = travelDir()
  const fetch2 = stubFetch([json({ code: 0, data: { state: "idle", daily_limit_reached: false } })])
  const acted2 = await runTravel({ directory: dir2, provider: "codebuddy", dispatch: false, travelOn: true, fetchImpl: fetch2 })
  assert.equal(acted2, 0)
  assert.equal(fetch2.calls.length, 1)
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
})

test("旅行：traveling → 等，arrived → 领奖", async () => {
  const dir = travelDir()
  const fetch = stubFetch([json({ code: 0, data: { state: "traveling" } })])
  assert.equal(await runTravel({ directory: dir, provider: "codebuddy", dispatch: true, travelOn: true, fetchImpl: fetch }), 0)
  assert.equal(travelState(dir).accounts["cat-1"].traveling, true)
  rmSync(dir, { recursive: true, force: true })

  const dir2 = travelDir()
  const fetch2 = stubFetch([
    json({ code: 0, data: { state: "arrived", record_id: 42 } }),
    json({ code: 0, data: { reward_credit: 30 } }),
  ])
  const acted = await runTravel({ directory: dir2, provider: "codebuddy", dispatch: true, travelOn: true, fetchImpl: fetch2 })
  assert.equal(acted, 1)
  assert.equal(JSON.parse(fetch2.calls[1].init.body).record_id, 42)
  const st = travelState(dir2)
  assert.equal(st.accounts["cat-1"].claimed, true)
  assert.equal(st.accounts["cat-1"].reward, 30)
  rmSync(dir2, { recursive: true, force: true })
})

test("旅行：每日上限 / 401 / 过期 token", async () => {
  const dir = travelDir()
  await runTravel({ directory: dir, provider: "codebuddy", dispatch: true, travelOn: true, fetchImpl: stubFetch([json({ code: 0, data: { state: "idle", daily_limit_reached: true } })]) })
  assert.equal(travelState(dir).accounts["cat-1"].done, true)
  rmSync(dir, { recursive: true, force: true })

  const dir2 = travelDir()
  await runTravel({ directory: dir2, provider: "codebuddy", dispatch: true, travelOn: true, fetchImpl: stubFetch([new Response("", { status: 401 })]) })
  assert.equal(travelState(dir2).accounts["cat-1"].skip, "unauthorized")
  rmSync(dir2, { recursive: true, force: true })

  const dir3 = travelDir()
  const all = JSON.parse(readFileSync(join(dir3, "plugin-auth.json"), "utf8"))
  all.codebuddy.expires = Date.now() - 1000
  writeFileSync(join(dir3, "plugin-auth.json"), JSON.stringify(all))
  await runTravel({ directory: dir3, provider: "codebuddy", dispatch: true, travelOn: true, fetchImpl: stubFetch([]) })
  assert.equal(travelState(dir3).accounts["cat-1"].skip, "token-expired")
  rmSync(dir3, { recursive: true, force: true })
})

test("旅行：只有国内版有这个开关", async () => {
  const cn = await WorkBuddyImportPlugin({ client, magpie: { option: () => undefined } })
  const ai = await WorkBuddyAIImportPlugin({ client, magpie: { option: () => undefined } })
  const keysOf = (h) => (h.auth.options ?? []).map((o) => o.key)
  assert.ok(keysOf(cn).includes("travel"))
  assert.ok(!keysOf(ai).includes("travel"))
})

test("旅行：travel-on 标记文件也能打开开关", async () => {
  const dir = travelDir()
  writeFileSync(join(dir, "travel-on"), "")
  const fetch = stubFetch([
    json({ code: 0, data: { state: "idle", daily_limit_reached: false } }),
    json({ code: 0, data: { enabled: true, locations: [{ id: 1, name: "北京" }] } }),
    json({ code: 0, data: { state: "traveling" } }),
  ])
  // magpie 的开关关着（option 返回 false），但标记文件在
  const acted = await runTravel({ directory: dir, provider: "codebuddy", dispatch: true, travelOn: false, fetchImpl: fetch, marker: true })
  assert.equal(acted, 1)
  rmSync(dir, { recursive: true, force: true })
})
