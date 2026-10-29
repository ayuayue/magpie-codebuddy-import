import { test } from "node:test"
import assert from "node:assert/strict"

import { DISPATCH_MS, CLAIM_MS, beijingHour, inQuietHours, msUntilBeijingHour, nextDelay } from "../lib/travel.mjs"

// 北京时间 → 时间戳（北京没有夏令时，固定 +08:00）
const bj = (day, hour, minute = 0) => Date.parse(`2026-10-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`)

test("北京时间与静默时段", () => {
  assert.equal(beijingHour(bj(29, 3)), 3)
  assert.equal(beijingHour(bj(29, 13)), 13)
  assert.equal(inQuietHours(bj(29, 3)), true)
  assert.equal(inQuietHours(bj(29, 1)), true)
  assert.equal(inQuietHours(bj(29, 8)), false)
  assert.equal(inQuietHours(bj(29, 0, 59)), false) // 静默从 01:00 才开始
  assert.equal(inQuietHours(bj(29, 12)), false)
})

test("到早上 8 点还有多久", () => {
  assert.equal(msUntilBeijingHour(8, bj(29, 3)), 5 * 3600_000)
  assert.equal(msUntilBeijingHour(8, bj(29, 7, 30)), 30 * 60_000)
  // 已经过了 8 点就算到明天
  assert.equal(msUntilBeijingHour(8, bj(29, 9)), 23 * 3600_000)
})

test("间隔按基准浮动，不会固定在一个点", () => {
  const noon = bj(29, 12)
  assert.equal(nextDelay(CLAIM_MS, noon, () => 0), Math.round(CLAIM_MS * 0.6))
  assert.equal(nextDelay(CLAIM_MS, noon, () => 0.5), CLAIM_MS)
  assert.equal(nextDelay(CLAIM_MS, noon, () => 1), Math.round(CLAIM_MS * 1.4))
  // 派发比领奖稀得多
  assert.ok(DISPATCH_MS > CLAIM_MS * 5)
})

test("落在夜里的都推到早上", () => {
  const lateNight = bj(29, 0, 50)
  const delay = nextDelay(CLAIM_MS, lateNight, () => 0)
  assert.ok(delay >= 7 * 3600_000, "00:50 之后再等一轮就进静默时段，应推到 8 点后")
  assert.ok(delay <= 7.5 * 3600_000)

  // 23:50 + 45 分钟 = 00:35，还没进静默，照常
  const nearMidnight = bj(29, 23, 50)
  assert.equal(nextDelay(CLAIM_MS, nearMidnight, () => 0.5), CLAIM_MS)
})
