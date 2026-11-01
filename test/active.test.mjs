import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

import { makeActive } from "../lib/active.mjs"
import { beijingDay } from "../lib/usage.mjs"

// 国际版（CodeBuddy AI）没有签到活动，奖励来自「今天在网页端跑过一轮 agent 会话」。
// 实测形状（2026-11-01 www.workbuddy.ai）：
//   建会话 → data.id 与 data.session{link,token,sessionId,cwd}
//   会话自始至终 status 从 CREATING 走到 completed
const AUTH = { type: "oauth", access: "at", refresh: "rt", expires: 1900000000000, uid: "u1", domain: "www.workbuddy.ai" }

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// record 把整轮网页对话串起来，同时把发出去的请求记下来给断言用
function world({ status = "completed", listToday = false, listAt = "", createStatus = 200, createBody = null } = {}) {
  const calls = []
  let polls = 0
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const method = (init.method ?? "GET").toUpperCase()
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    if (u.includes("/activity/growth/streak")) return json({ code: 0, data: { streak: { days: 3 } } })
    if (u.includes("/console/as/conversations/") && method === "POST" && !/\/(stop|delete)$/.test(u)) {
      if (createBody) return json(createBody, createStatus)
      return json({ code: 0, data: { id: "c1", name: "Hi", status: "CREATING", session: { sessionId: "s1", link: "https://sandbox.example/acp", token: "st", cwd: "/workspace" } } })
    }
    if (u.includes("://sandbox.example")) {
      if (method === "GET") {
        return new Response("data: {}\n", { status: 200, headers: { "acp-connection-id": "conn1", "content-type": "text/event-stream" } })
      }
      return new Response("", { status: 202 })
    }
    // 会话列表
    if (u.includes("/console/as/conversations/?") && method === "GET") {
      const at = listAt || beijingDay(0) + "T09:00:00+08:00"
      return json({ code: 0, data: { conversations: listToday ? [{ id: "old", name: "Hi", status: "completed", createdAt: at }] : [] } })
    }
    // 单条会话状态
    if (u.includes("/console/as/conversations/") && method === "GET") {
      polls++
      return json({ code: 0, data: { id: "c1", status: polls > 1 ? status : "working" } })
    }
    return json({ code: 0, data: {} })
  }
  return { fetchImpl, calls, polls: () => polls }
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "wb-active-"))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("跑完一轮网页会话就报 claimed，并记下今天", async () => {
  await withDir(async (directory) => {
    const w = world()
    const active = makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 })
    const out = await active.run(async () => AUTH)
    assert.equal(out.outcome, "claimed")
    assert.equal(out.streak, 3)
    // 走的就是网页通道：建会话用的是那句提示词与免费模型
    const created = w.calls.find((c) => c.method === "POST" && /conversations\/$/.test(c.url))
    assert.ok(created, "应该建一条网页会话")
    assert.equal(created.body.prompt, "Hi")
    assert.equal(created.body.conversationOrigin, "workbuddy-app")
    // 不拿贵模型去烧额度
    assert.equal(created.body.model, "deepseek-v4.1-flash")
    // ACP 四步都发了，顺序固定
    const rpc = w.calls.filter((c) => c.url.startsWith("https://sandbox.example")).map((c) => c.body?.method).filter(Boolean)
    assert.deepEqual(rpc, ["initialize", "session/load", "session/set_model", "session/prompt"])
    // 跑完要收尾：只 stop，历史留着
    const acts = w.calls.filter((c) => /\/(stop|delete)$/.test(c.url)).map((c) => c.url.split("/").pop())
    assert.deepEqual(acts, ["stop"])
  })
})

test("今天已经跑过就不发请求（本地记的那一笔）", async () => {
  await withDir(async (directory) => {
    writeFileSync(join(directory, "workbuddy-active-state.json"), JSON.stringify({ u1: beijingDay(0) }))
    const w = world()
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "done")
    assert.deepEqual(w.calls.map((c) => c.url).filter((u) => u.includes("/console/")), [])
  })
})

test("本地没记但会话列表里今天有一条，也算已活跃", async () => {
  await withDir(async (directory) => {
    const w = world({ listToday: true })
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "done")
    // 认出今天那条之后要把结论落盘，下次连列表都不用翻
    const { readFileSync } = await import("node:fs")
    const kept = JSON.parse(readFileSync(join(directory, "workbuddy-active-state.json"), "utf8"))
    assert.equal(kept.u1, beijingDay(0))
  })
})

test("会话跑成 failed 就报 failed，并把它删掉不占名额", async () => {
  await withDir(async (directory) => {
    const w = world({ status: "failed" })
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "failed")
    assert.match(out.message, /failed/)
    const acts = w.calls.filter((c) => /\/(stop|delete)$/.test(c.url)).map((c) => c.url.split("/").pop())
    assert.deepEqual(acts, ["stop", "delete"])
    // 失败不能记成今天做过，否则当天再也补不上
    const { readFileSync, existsSync } = await import("node:fs")
    const file = join(directory, "workbuddy-active-state.json")
    assert.equal(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).u1 : undefined, undefined)
  })
})

test("建会话被业务拒绝时如实报错，不重试", async () => {
  await withDir(async (directory) => {
    const w = world({ createStatus: 403, createBody: { code: 11140, msg: "request illegal" } })
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "failed")
    assert.match(out.message, /11140|建会话失败/)
    assert.equal(w.calls.filter((c) => c.method === "POST" && /conversations\/$/.test(c.url)).length, 1)
  })
})

test("没有登录就不发请求", async () => {
  await withDir(async (directory) => {
    const w = world()
    const active = makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 })
    await assert.rejects(() => active.run(async () => ({ type: "oauth", source: "desktop" })), /没有可用的登录/)
    assert.equal(w.calls.length, 0)
  })
})

test("桌面端登录由 resolve 现取 token", async () => {
  await withDir(async (directory) => {
    const w = world()
    const active = makeActive({ fetchImpl: w.fetchImpl, directory, resolve: async () => AUTH, pollEvery: 1 })
    const out = await active.run(async () => ({ type: "oauth", source: "desktop", access: "", expires: 0 }))
    assert.equal(out.outcome, "claimed")
  })
})

test("会话状态大写也认得出完成", async () => {
  await withDir(async (directory) => {
    const w = world({ status: "COMPLETED" })
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "claimed")
    // 认出来就只 stop，不能当失败 stop + delete
    const acts = w.calls.filter((c) => /\/(stop|delete)$/.test(c.url)).map((c) => c.url.split("/").pop())
    assert.deepEqual(acts, ["stop"])
  })
})

test("会话列表里带 UTC 的时间也按北京日算", async () => {
  await withDir(async (directory) => {
    // 北京时间今天 01:30 = UTC 昨天 17:30。按字符串前 10 位会认成昨天，白跑一轮
    const utc = new Date(Date.parse(beijingDay(0) + "T01:30:00+08:00")).toISOString()
    assert.notEqual(utc.slice(0, 10), beijingDay(0), "这个时刻的 UTC 日期应该和北京日不同")
    const w = world({ listToday: true, listAt: utc })
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "done")
    assert.equal(w.calls.filter((c) => c.method === "POST" && /conversations\/$/.test(c.url)).length, 0)
  })
})

test("claimed 给出下一个北京零点，省掉当天反复追问", async () => {
  await withDir(async (directory) => {
    const w = world()
    const before = Date.now()
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "claimed")
    const until = Number(out.until)
    assert.ok(Number.isFinite(until), "until 要是一个能读的时间")
    assert.ok(until > before, "until 应该是将来的时刻")
    // 正好落在北京零点上，且不超过 24 小时
    const t = new Date(until)
    assert.equal(t.toISOString().slice(11, 13), "16", "北京零点 = UTC 16:00")
    assert.ok(until - before <= 24 * 3600_000 && until - before > 0)
  })
})

test("already done 不给 until：那只是本地说今天做过了", async () => {
  await withDir(async (directory) => {
    writeFileSync(join(directory, "workbuddy-active-state.json"), JSON.stringify({ u1: beijingDay(0) }))
    const w = world()
    const out = await makeActive({ fetchImpl: w.fetchImpl, directory, pollEvery: 1 }).run(async () => AUTH)
    assert.equal(out.outcome, "done")
    assert.equal(out.until, undefined)
  })
})
