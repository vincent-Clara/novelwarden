/**
 * node:test 的精簡 reporter：只吐失敗與總計。
 *
 * 預設 spec/tap reporter 每條失敗帶十幾行 YAML（duration_ms、location、完整 stack），
 * 幾百個用例跑下來輸出以萬字計——人要往回翻，塞進 agent 上下文更是純浪費。
 * 這裡每條失敗壓成兩三行：位置 + 用例全名 + 期望/實際。
 *
 *   node --test --test-reporter=./tests/reporters/quiet.mjs "tests/unit/**\/*.test.js"
 *
 * 環境變數：
 *   NF_TEST_LOGS=1        連帶列印失敗檔案裡的 console 輸出（預設丟棄）
 *   NF_TEST_MAX_FAILS=n   最多詳細展示幾條失敗，超出只計數（預設 25，0 表示不限）
 *   NF_TEST_STACK=1       每條失敗附一行倉庫內的呼叫位置
 */

import path from 'node:path'

const CWD = process.cwd()
const SHOW_LOGS = process.env.NF_TEST_LOGS === '1'
const SHOW_STACK = process.env.NF_TEST_STACK === '1'
const MAX_FAILS = process.env.NF_TEST_MAX_FAILS === undefined
  ? 25
  : Number(process.env.NF_TEST_MAX_FAILS) || Infinity

const VALUE_CAP = 160
const MSG_CAP = 300

const rel = (f) => (f ? path.relative(CWD, f).replaceAll('\\', '/') : '?')

/**
 * 事件之間的檔案鍵。
 *
 * `test:stderr` 給的是**命令列上那個寫法**（多半是相對路徑），`test:fail` 給的是絕對路徑——
 * 兩邊直接當 key 用會對不上，載入期崩潰就查不到真正的原因。統一 resolve 一次。
 */
const key = (f) => (f ? path.resolve(CWD, f) : '')

/** 壓成單行並截斷——多行 diff 是 reporter 體積的主要來源。 */
function flat(s, cap) {
  const one = String(s).replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return one.length > cap ? one.slice(0, cap) + ` …(共 ${one.length} 字)` : one
}

function show(v) {
  if (typeof v === 'string') return flat(JSON.stringify(v), VALUE_CAP)
  if (v === undefined) return 'undefined'
  try {
    return flat(JSON.stringify(v), VALUE_CAP)
  } catch {
    return flat(String(v), VALUE_CAP)
  }
}

/** 兩個長字串只報第一處分歧，別把兩份全文都印出來。 */
function diffHint(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null
  if (a.length < 80 && b.length < 80) return null
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const win = (s) => flat(JSON.stringify(s.slice(Math.max(0, i - 20), i + 40)), VALUE_CAP)
  return `第 ${i} 字起分歧：實際 ${win(a)} / 期望 ${win(b)}`
}

/** 找出第一幀落在倉庫裡、又不在 tests/helpers 的呼叫位置。 */
function repoFrame(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = line.match(/\(?([A-Za-z]:[\\/][^):]+|\/[^):]+):(\d+):(\d+)\)?$/)
    if (!m) continue
    if (m[1].includes('node_modules') || m[1].startsWith('node:')) continue
    const r = rel(m[1])
    if (r.startsWith('..')) continue
    return `${r}:${m[2]}`
  }
  return null
}

export default async function* quiet(source) {
  /** 每個檔案一份祖先棧——檔案之間是並行跑的，事件會交錯。 */
  const stacks = new Map()
  const logs = new Map()
  const errs = new Map()
  let failed = 0
  let counts = null
  let durationMs = 0

  /** 邊跑邊吐失敗，不攢到最後——整輪要跑幾十秒，第一條失敗該立刻看見。 */
  function* render(f) {
    yield `\n✗ ${f.file}${f.line ? ':' + f.line : ''}\n  ${f.name}\n`
    const c = f.cause
    if (c && typeof c === 'object' && 'expected' in c && 'actual' in c) {
      const hint = diffHint(c.actual, c.expected)
      yield hint
        ? `  ${hint}\n`
        : `  實際 ${show(c.actual)}\n  期望 ${show(c.expected)}${c.operator ? `（${c.operator}）` : ''}\n`
      if (c.generatedMessage === false) yield `  ${flat(c.message, MSG_CAP)}\n`
    } else if (f.bare) {
      // 檔案在載入期就崩時，node 只給一句 "test failed"，真正的原因在 stderr 上。
      const first = (errs.get(f.rawFile) || []).find((l) => /\w*Error\b/.test(l))
      yield `  ${flat(first || c, MSG_CAP)}\n`
    } else {
      const name = c?.constructor?.name
      yield `  ${name && name !== 'Error' ? name + ': ' : ''}${flat(c?.message ?? c, MSG_CAP)}\n`
    }
    if (SHOW_STACK) {
      const at = repoFrame(f.stack)
      if (at) yield `  at ${at}\n`
    }
    if (SHOW_LOGS) {
      const buf = logs.get(f.rawFile)
      // 日誌是按檔案收的，不是按用例——同檔案多條失敗會各自附上同一份。
      if (buf?.length) yield `  ── ${f.file} 的輸出 ──\n` + buf.map((l) => '  │ ' + flat(l, MSG_CAP)).join('\n') + '\n'
    }
  }

  for await (const event of source) {
    const d = event.data || {}

    switch (event.type) {
      case 'test:start': {
        const k = key(d.file)
        const s = stacks.get(k) || []
        s.length = d.nesting
        s[d.nesting] = d.name
        stacks.set(k, s)
        break
      }

      case 'test:stderr': {
        // stderr 始終留一份：載入期崩潰的真實原因只在這裡。
        const eb = errs.get(key(d.file)) || []
        eb.push(d.message)
        if (eb.length > 60) eb.shift()
        errs.set(key(d.file), eb)
      }
      // fallthrough：stderr 也算日誌
      case 'test:stdout': {
        if (!SHOW_LOGS) break
        const buf = logs.get(key(d.file)) || []
        buf.push(d.message)
        if (buf.length > 40) buf.shift()
        logs.set(key(d.file), buf)
        break
      }

      case 'test:fail': {
        const err = d.details?.error
        // 套件的失敗只是子用例失敗的回聲，葉子那條已經報過了。
        if (err?.failureType === 'subtestsFailed') break
        failed++
        if (failed > MAX_FAILS) break
        const s = stacks.get(key(d.file)) || []
        const trail = s.slice(0, d.nesting).filter(Boolean)
        const cause = err?.cause ?? err
        yield* render({
          rawFile: key(d.file),
          file: rel(d.file),
          line: d.line,
          name: [...trail, d.name].join(' › '),
          cause,
          bare: typeof cause === 'string',
          stack: err?.cause?.stack || err?.stack,
        })
        break
      }

      case 'test:summary': {
        // 每個檔案一條、末尾再來一條總的（無 file）——只認總的那條。
        if (d.file) break
        counts = d.counts
        durationMs = d.duration_ms
        break
      }
    }
  }

  if (failed > MAX_FAILS) {
    yield `\n…另有 ${failed - MAX_FAILS} 條失敗未展開（NF_TEST_MAX_FAILS=0 看全部）\n`
  }
  if (!counts) {
    yield '\n沒有拿到彙總——多半是某個測試檔案在載入期就崩了。\n'
    return
  }

  const secs = (durationMs / 1000).toFixed(1)
  const bits = [`通過 ${counts.passed}`]
  // 用葉子失敗數，不用 counts.failed——後者把套件的 rollup 也算了進去，與上面展開的條數對不上。
  if (failed) bits.push(`失敗 ${failed}`)
  if (counts.skipped) bits.push(`跳過 ${counts.skipped}`)
  if (counts.todo) bits.push(`todo ${counts.todo}`)
  if (counts.cancelled) bits.push(`取消 ${counts.cancelled}`)
  yield `\n${failed ? '✗' : '✓'} ${bits.join(' / ')}，${counts.tests} 條，${secs}s\n`
}
