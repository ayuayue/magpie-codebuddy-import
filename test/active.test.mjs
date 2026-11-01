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
function world({ status = "completed", listToday = false, createStatus = 200, createBody = null } = {}) {
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
      return json({ code: 0, data: { conversations: listToday ? [{ id: "old", name: "Hi", status: "completed", createdAt: beijingDay(0) + "T09:00:00+08:00" }] : [] } })
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
