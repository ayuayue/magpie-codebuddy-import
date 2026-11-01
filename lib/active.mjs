// 国际版（CodeBuddy AI / www.workbuddy.ai）的「每日活跃」。
//
// 国际版没有签到活动：POST /v2/billing/meter/checkin-activity-status 对每个国际版
// 账号都回 active:false（实测 2026-11-01，5 个账号全一样），所以 makeCheckin 那套
// 只能给出 outcome:"inactive"，卡片上写「当前没有签到活动」，按一下也没有任何收益。
//
// 国际版的每日奖励走另一条路：在 workbuddy.ai 的网页端真的跑一轮 agent 会话
// （网页 conversation，ACP over streamable HTTP）。参照 workbuddy2api-hub
// 的 daily_chat_web（issue #75/#59/#90：只建会话不算，必须接上沙箱把这一轮驱跑
// 到 completed；#623：跑完必须收尾，否则十天后活跃会话攒满 10 条就再也建不出来）。
//
// hub 还有一条「桌面身分的轻量 chat」的腿（POST /v2/chat/completions）。这里不做：
// 实测 2026-11-01 用桌面头打那个接口，回 400 code 11128「Request blocked …failed
// channel verification」，要过它得复刻整套客户端指纹（gzip 体、cache_retention、
// CLI 头族），代价远大于收益，而且真正计入积分的本来就是网页会话那条。
//
// 所以这里的步骤就是 hub 的 _daily_chat_web_once：
//   建会话 → 取沙箱 link+token → 开 SSE 拿 Acp-Connection-Id →
//   initialize / session/load / session/set_model / session/prompt →
//   轮询会话状态到 completed → stop（失败则 stop + delete）
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { beijingDay } from "./usage.mjs"

const WEB_ORIGIN = "https://www.workbuddy.ai"
const CONVERSATIONS = WEB_ORIGIN + "/console/as/conversations/"
const STREAK = "/activity/growth/streak"

// 会话名就是提示词。和 hub 用同一句：两边谁先打过卡，另一边都认得出今天已经活跃过
const PROMPT = "Hi"
// 每日活跃只跑免费模型（0.00x 积分），别拿贵模型去烧额度
const MODEL = "deepseek-v4.1-flash"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
// 上游对单账号同时存在的活跃会话（working/creating）有硬上限 10 条
const ACTIVE_LIMIT = /10105|maximum number of active conversations/i
// 一轮最多等多久：magpie 给插件方法的总预算约 2 分钟（host.go 的 2*time.Minute），
// 实测一次「Hi」十几秒跑完，留足余量但别把预算用满
const TURN_BUDGET = 90_000
const POLL_EVERY = 2_500
// 今天打过卡的账号记在这里（一个文件，按 uid 一行日期），省得每次都去翻会话列表
const STATE_FILE = "workbuddy-active-state.json"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function headers(auth, extra = {}) {
  return {
    authorization: "Bearer " + auth.access,
    "x-user-id": auth.uid ?? "",
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    origin: WEB_ORIGIN,
    referer: WEB_ORIGIN + "/app",
    "user-agent": UA,
    ...(auth.domain ? { "x-domain": auth.domain } : {}),
    ...extra,
  }
}

// json 用 fetch 取一段 JSON；HTTP 非 2xx 也把 body 读出来（上游把错误码放在
// body 的 code 里，光看状态码分不清 11140 风控和 10105 名额满了）
async function json(doFetch, url, init, ms = 30_000) {
  const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(ms) })
  const text = await res.text()
  let body = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {}
  return { res, body, text }
}

// streakOf 读连登天数（GET /activity/growth/streak）。读不到就算了，卡片上少一句而已
async function streakOf(doFetch, auth) {
  try {
    const { body } = await json(doFetch, WEB_ORIGIN + STREAK, { method: "GET", headers: headers(auth) }, 15_000)
    const days = body?.data?.streak?.days
    return typeof days === "number" && days >= 0 ? days : undefined
  } catch {
    return undefined
  }
}

// todayActive 说这个账号今天是不是已经在网页端跑过一轮：问会话列表里有没有今天
// 建的、名字就是那句提示词的会话。跑成功的会话只 stop 不 delete（历史留着），
// 所以它一直在列表里；hub 打卡留下的也一样认。
async function todayActive(doFetch, auth) {
  const { body } = await json(
    doFetch,
    CONVERSATIONS + "?page=1&pageSize=20",
    { method: "GET", headers: headers(auth) },
    20_000,
  )
  const list = body?.data?.conversations
  if (!Array.isArray(list)) return undefined
  const today = beijingDay(0)
  return list.some((c) => {
    if (String(c?.name ?? "").trim() !== PROMPT) return false
    const at = String(c?.createdAt ?? c?.created_at ?? c?.createTime ?? "")
    return at.slice(0, 10) === today || at.replace("T", " ").slice(0, 10) === today
  })
}

// openAcp 打开沙箱的 SSE 通道，返回 {connId, close}。通道要一直有人读，否则
// agent 的 session/update 会把它塞满，服务端不再推进
async function openAcp(doFetch, link, token) {
  const ctl = new AbortController()
  const res = await doFetch(link, {
    method: "GET",
    headers: { accept: "text/event-stream", authorization: "Bearer " + token, "user-agent": UA },
    signal: ctl.signal,
  })
  const connId = res.headers.get("acp-connection-id") ?? ""
  let chunks = 0
  ;(async () => {
    try {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const line of dec.decode(value).split("\n")) {
          if (!line.startsWith("data:")) continue
          const p = line.slice(5).trim()
          if (!p || p === "[DONE]") continue
          try {
            const m = JSON.parse(p)
            if (m?.method === "session/update" && m?.params?.update?.sessionUpdate === "agent_message_chunk") chunks++
          } catch {}
        }
      }
    } catch {}
  })()
  return { connId, close: () => ctl.abort(), chunks: () => chunks }
}

// runActivity 跑一轮网页活跃；返回 {ok, status, conversation, chunks, elapsed, error}。
// 任何一步失败都不冒泡：调用方按 outcome 说话。
async function runActivity(doFetch, auth, conversation, pollEvery = POLL_EVERY) {
  const started = Date.now()
  const deadline = started + TURN_BUDGET
  let id = conversation
  let opened = null
  const out = { ok: false, conversation: id, status: "", chunks: 0, elapsed: 0, error: "" }

  const create = async () =>
    json(
      doFetch,
      CONVERSATIONS,
      {
        method: "POST",
        headers: headers(auth),
        body: JSON.stringify({
          prompt: PROMPT,
          model: MODEL,
          conversationOrigin: "workbuddy-app",
          plugins: [{ name: "weixinpay", marketplace: "codebuddy-builtin" }],
        }),
      },
      30_000,
    )

  try {
    let { res, body, text } = await create()
    if (ACTIVE_LIMIT.test(text) || res.status === 429) {
      // 名额满了：只停我们自己建的那种会话（名字就是提示词），用户自己的对话不碰
      await freeSlots(doFetch, auth, started)
      ;({ res, body, text } = await create())
      if (ACTIVE_LIMIT.test(text)) {
        out.error = "活跃会话已达上限（10 条），请到 www.workbuddy.ai 网页端结束旧对话后重试"
        return out
      }
    }
    if (!res.ok || (body?.code != null && body.code !== 0)) {
      out.error = "建会话失败：HTTP " + res.status + " " + (body?.msg ?? text.slice(0, 120))
      return out
    }
    id = body?.data?.id
    out.conversation = id
    if (!id) {
      out.error = "建会话没有返回会话 id"
      return out
    }

    // 沙箱：建会话的回复里就带着，缺了再问一次 /session
    let ses = body?.data?.session ?? {}
    if (!ses.link || !ses.token) {
      const got = await json(doFetch, CONVERSATIONS + encodeURIComponent(String(id)) + "/session", {
        method: "GET",
        headers: headers(auth),
      })
      ses = got.body?.data ?? {}
    }
    if (!ses.link || !ses.token) {
      out.error = "沙箱未就绪（没有 link/token）"
      return out
    }

    opened = await openAcp(doFetch, ses.link, ses.token)
    if (!opened.connId) {
      out.error = "沙箱没有给出 Acp-Connection-Id"
      return out
    }

    const rpc = async (method, params, rid) => {
      const r = await json(
        doFetch,
        ses.link,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "acp-connection-id": opened.connId,
            authorization: "Bearer " + ses.token,
            "user-agent": UA,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }),
        },
        30_000,
      )
      if (r.res.status >= 400) throw new Error(method + " 回了 HTTP " + r.res.status + " " + r.text.slice(0, 120))
    }

    const sessionId = ses.sessionId ?? ses.session_id ?? id
    await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 1)
    await rpc("session/load", { sessionId, cwd: ses.cwd ?? "/workspace", mcpServers: [] }, 2)
    // 换模型是加分项：换不动就按它默认的模型跑，一样算一轮对话
    try {
      await rpc("session/set_model", { sessionId, modelId: MODEL }, 3)
    } catch {}
    await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: PROMPT }] }, 4)

    // 只建会话不算活跃：要等这一轮真的跑完（issue #90）
    for (;;) {
      if (Date.now() > deadline) {
        out.error = "会话在 " + Math.round(TURN_BUDGET / 1000) + " 秒内没有跑完"
        return out
      }
      await sleep(pollEvery)
      const st = await json(doFetch, CONVERSATIONS + encodeURIComponent(String(id)), { method: "GET", headers: headers(auth) })
      const status = String(st.body?.data?.status ?? "")
      out.status = status
      if (status === "completed") {
        out.ok = true
        break
      }
      if (status === "failed" || status === "error" || status === "cancelled") {
        out.error = "会话结束于 " + status
        return out
      }
    }
    return out
  } catch (e) {
    out.error = e?.message ?? String(e)
    return out
  } finally {
    out.chunks = opened?.chunks?.() ?? 0
    out.elapsed = Date.now() - started
    try {
      opened?.close()
    } catch {}
    if (id) await close(doFetch, auth, id, !out.ok)
  }
}

// close 收尾：成功只 stop（历史留着），失败再 delete，别把名额漏在那儿
async function close(doFetch, auth, id, del) {
  const url = CONVERSATIONS + encodeURIComponent(String(id))
  for (const action of del ? ["stop", "delete"] : ["stop"]) {
    try {
      await json(doFetch, url + "/" + action, { method: "POST", headers: headers(auth), body: "{}" }, 20_000)
    } catch {}
  }
}

// freeSlots 在撞到 10 条上限时，停掉最旧的几条「打卡会话」腾名额
async function freeSlots(doFetch, auth, now) {
  try {
    const { body } = await json(doFetch, CONVERSATIONS + "?page=1&pageSize=50", { method: "GET", headers: headers(auth) })
    const list = Array.isArray(body?.data?.conversations) ? body.data.conversations : []
    const active = list
      .filter((c) => /^(working|creating|pending)$/i.test(String(c?.status ?? "")))
      // 只动名字是那句提示词的会话，用户自己的对话不碰
      .filter((c) => String(c?.name ?? "").trim() === PROMPT)
      .sort((a, b) => String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? "")))
    let stopped = 0
    for (const c of active) {
      if (stopped >= 3) break
      if (String(c?.createdAt ?? "").length && Date.parse(String(c.createdAt)) > now) continue
      await close(doFetch, auth, c.id ?? c.conversationId, false)
      stopped++
    }
  } catch {}
}

// makeActive 是国际版的「每日活跃」：一次调用 = 一轮网页 agent 会话。
//
// 国际版没有签到活动，奖励来自「今天在 workbuddy.ai 上跑过一轮 agent 会话」，
// 所以这里把 magpie 的签到钩子接到那件事上：跑完一轮就是「今日已签到」。
//
// 今天是不是已经活跃过，只认会话列表里那一条（名字就是提示词、创建于今天）：
// 跑完的会话只 stop 不 delete，它一直留在历史里。所以要找的是「今天有没有」，
// 不是「今天成功没成功」——会话建出来就说明今天已经算过一次了，再跑一遍也不会
// 多给积分，只会白烧额度。
// resolve 由调用方给（index.mjs 的 authFor）：桌面端登录的账号 access 是空的，
// 要现去 WorkBuddy 自己的文件里读。不给就按 magpie 交来的原样用。
export function makeActive({ fetchImpl, directory, resolve, pollEvery } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const stateFile = directory ? join(directory, STATE_FILE) : ""

  const readState = () => {
    if (!stateFile) return {}
    try {
      const kept = JSON.parse(readFileSync(stateFile, "utf8"))
      return kept && typeof kept === "object" ? kept : {}
    } catch {
      return {}
    }
  }
  const writeState = (state) => {
    if (!stateFile) return
    try {
      mkdirSync(directory, { recursive: true })
      const temp = stateFile + ".tmp"
      writeFileSync(temp, JSON.stringify(state, null, 2))
      renameSync(temp, stateFile)
    } catch {}
  }

  return {
    async run(getAuth) {
      const stored = await getAuth()
      const auth = resolve ? await resolve(stored) : stored
      if (!auth?.access) throw new Error("这个账号没有可用的登录，先登录再活跃")
      const key = String(auth.uid ?? auth.accountId ?? "default")
      const streak = () => streakOf(doFetch, auth)

      // 今天已经打过卡：本地记的那一笔最省事，其次看会话列表里有没有今天的
      // 一轮。上游没有「今天活跃过没有」的查询接口（hub 也是自己记），所以两样
      // 都要，缺一样就退化成再跑一轮 —— 多跑不给积分，只是白烧一次会话。
      const kept = readState()
      if (kept[key] === beijingDay(0)) return { outcome: "done", streak: await streak() }
      try {
        if ((await todayActive(doFetch, auth)) === true) {
          kept[key] = beijingDay(0)
          writeState(kept)
          return { outcome: "done", streak: await streak() }
        }
      } catch {}

      const r = await runActivity(doFetch, auth, undefined, pollEvery)
      if (!r.ok) return { outcome: "failed", message: r.error || "网页活跃会话没有跑完" }
      kept[key] = beijingDay(0)
      writeState(kept)
      return { outcome: "claimed", streak: await streak(), message: "已跑完一轮网页 agent 会话" }
    },
  }
}
