// WorkBuddy 的"当日已用积分"。
//
// 上游插件报的是一个账单周期的累计已用（各包 CycleUsedCapacity 之和）。magpie
// 的按天用量（credits_daily.go）没有别的来源，只能把相邻两次读数的差记到后一次
// 那天，且**差值为负就当作周期重开、这段不计**。WorkBuddy 国内版的积分是几十个
// 各自滚动 30 天的包（实测一个账号 69 个、每包 50 分，发放时间散布在全天），包一
// 过期，累计已用就倒退一截 —— 于是当天常常显示 0，或把昨天的量记到今天。实测
// 2026-10-28：某账号真实 551.95 分，magpie 一条没记到；另一个真实 83.68，只记到
// 5.22；还有一个 magpie 记的比真实多出一倍。
//
// WorkBuddy 自己有请求流水 /billing/meter/get-user-request-usage，逐笔给出
// credit 和 requestTime（北京时间），也包含走它自家 App/IDE 的请求，不只看
// magpie 这条路 —— 按北京日聚合它就是真数。
//
// 只查一天，别图省事一次查一周：实测（同一账号 2026-10-29）范围查询会把跨午夜
// 的行重分到两边 —— 逐日查 10-28 得 71.99/48 笔、10-29 得 141.98/10 笔，而一次
// 查 10-23~10-29 却报 10-28 198.86/44 笔、10-29 11.07/8 笔。逐日查两边都对得上。
const PAGE_SIZE = 200
const PAGES_MAX = 10 // 一天最多 2000 笔；再多就在 display 上标「≥」

const MS_DAY = 86400_000

// beijingDay 是 at 所在北京日（offset 负数往前几天）。
export function beijingDay(offset = 0, at = Date.now()) {
  return new Date(at + 8 * 3600_000 + offset * MS_DAY).toISOString().slice(0, 10)
}

// meterAsked 与上游用量那条请求同一套头：这些接口认 WorkBuddy 客户端的头，
// 签到那套（x-client-platform: web）读额度不一定读得动。
export async function meterAsked(site, auth, path, body = {}, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(site.endpoint + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": `WorkBuddy/${site.app}`,
      authorization: "Bearer " + auth.access,
      "x-user-id": auth.uid ?? "",
      "x-domain": auth.domain || new URL(site.endpoint).host,
      "x-product": "SaaS",
      "x-ide-type": "WorkBuddy",
      ...(auth.enterpriseId ? { "x-enterprise-id": auth.enterpriseId, "x-tenant-id": auth.enterpriseId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const env = await res.json().catch(() => ({}))
  const code = Number(env?.code) || 0
  if (!res.ok || code) {
    throw Object.assign(new Error(env?.msg || env?.message || `HTTP ${res.status}`), { status: res.status, code })
  }
  return env?.data ?? null
}

// creditsOn 是 day 那天这个账号用掉的积分与请求数。
export async function creditsOn(site, auth, { day = beijingDay(), fetchImpl } = {}) {
  let credit = 0
  let count = 0
  for (let page = 1; page <= PAGES_MAX; page++) {
    const data = await meterAsked(site, auth, "/billing/meter/get-user-request-usage", {
      startTime: `${day} 00:00:00`,
      endTime: `${day} 23:59:59`,
      pageNum: page,
      pageSize: PAGE_SIZE,
    }, fetchImpl)
    const got = Array.isArray(data?.data) ? data.data : []
    for (const row of got) {
      // 时间认不出就整行丢掉：把一笔请求算到别的日子，比少算一笔更糟
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(row?.requestTime ?? "").trim())) continue
      if (String(row.requestTime).slice(0, 10) !== day) continue
      const n = Number(row?.credit)
      credit += Number.isFinite(n) ? n : 0
      count++
    }
    if (got.length < PAGE_SIZE) return { credit, count, capped: false }
  }
  return { credit, count, capped: true }
}

// compact 把积分数成不啰嗦的样子：12.5 而不是 12.50000001。
function compact(n) {
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r).replace(/0+$/, "").replace(/\.$/, "")
}

// dayWindows 是卡片上「今日」那一行。读不到流水就什么也不加 —— 用量卡片照旧，
// 不该因为多一行展示而整个报错。
export async function dayWindows(site, auth, { fetchImpl, at = Date.now() } = {}) {
  let today
  try {
    today = await creditsOn(site, auth, { day: beijingDay(0, at), fetchImpl })
  } catch {
    return []
  }
  const more = today.capped ? "≥" : ""
  return [{
    name: "今日",
    aside: true,
    display: today.count
      ? `${more}${compact(today.credit)} 积分 · ${more}${today.count} 次请求`
      : "今天还没有请求",
  }]
}
