// 上传前自检：这个仓库里不该有你的库、钥匙、台账、语料或本机路径。
//
// 为什么需要它：`sources.mjs` / `sources.local.json` 已经不进仓库了，但"运行时数据"
// （ledger.ndjson、lessons.json、corpus/、.credentials.yaml、.env）的家在 $DSH_HOME——
// 万一有人在仓库目录里跑插件，它们就会落进来；一次 `git add .` 就上去了。
//
// 用法：node scripts/preflight-upload.mjs      （命中任何一条 → 非零退出）
// 它只读文件，不联网、不改任何东西。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/** 不该出现在仓库里的文件名（含目录）。 */
const FORBIDDEN = [
  /^sources\.mjs$/,
  /^sources\.local\.json$/,
  /^ledger\.ndjson$/,
  /^lessons\.json$/,
  /^\.credentials\.ya?ml$/,
  /^\.env$/,
  /^\.env\.[^/]+$/,
  /^stash-export-/,
]
const FORBIDDEN_DIRS = new Set(['corpus', 'cache'])

/**
 * 你不希望被公开的本机痕迹。刻意用**特征**而不是具体值：
 * 具体值写进仓库，本身就是一次泄露。
 *
 * 规则要窄，否则天天误报就没人看了：下面两条都要求"真的像数据"才命中——
 *   · 回环地址只在 `url:` / `endpoint:` 这种登记条目的字段里才算数
 *     （测试自己的 baseURI、文档里的说明不算）；
 *   · 私钥要求后面真的跟着一段 base64 正文（文档里列举特征名不算）。
 */
const SUSPICIOUS = [
  { label: 'Windows 用户目录绝对路径', re: /[A-Za-z]:\\Users\\(?!<|\{|\$)[^\\\s"']+\\[^\\\s"']*/ },
  { label: 'macOS / Linux 用户目录绝对路径', re: /\/(?:Users|home)\/(?!<|\{|\$|user|username|you|your)[a-z0-9._-]+\/[^\s"']+/i },
  { label: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|cn|net|org|io|dev|me|co)\b/ },
  { label: '疑似库条目的本机回环地址', re: /(?:url|endpoint)["']?\s*[:=]\s*["']https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i },
  { label: '疑似 API key / token 值', re: /\b(sk-[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/ },
  { label: '疑似私钥正文', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,40}\n[A-Za-z0-9+/=]{200,}/ },
]

const problems = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    const rel = relative(ROOT, full).split('\\').join('/')
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRS.has(entry.name)) problems.push(`目录不该在仓库里：${rel}/`)
      walk(full)
      continue
    }
    if (FORBIDDEN.some((re) => re.test(entry.name))) {
      problems.push(`文件不该在仓库里：${rel}`)
      continue
    }
    // 只扫文本类，且跳过本脚本自己（它里面就写着这些特征）
    if (!/\.(mjs|js|json|md|yml|yaml|txt|example)$/.test(entry.name)) continue
    if (rel === 'scripts/preflight-upload.mjs') continue

    // UTF-8 BOM：Windows 上用 PowerShell 的 `Set-Content -Encoding utf8` 改文件会加上它。
    // 它会让 JSON.parse 直接失败——DSH 的插件管理器就是这么读 package.json 的，
    // 带 BOM 的包一装就报 `cannot resolve profile bundle`。必须在推之前挡下。
    {
      const head = readFileSync(full).subarray(0, 3)
      if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        problems.push(`${rel}：文件带 UTF-8 BOM（JSON.parse 会失败，改文件请用不带 BOM 的写法）`)
      }
    }

    let text
    try {
      if (statSync(full).size > 2 * 1024 * 1024) continue
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const { label, re } of SUSPICIOUS) {
      const hit = text.match(re)
      if (hit) problems.push(`${rel}：${label} —— ${String(hit[0]).slice(0, 60)}`)
    }
  }
}

walk(ROOT)

if (problems.length > 0) {
  console.log('❌ 上传前自检未通过，先处理这些再推：')
  for (const line of problems) console.log(`   · ${line}`)
  process.exit(1)
}
console.log('✅ 上传前自检通过：仓库里没有库清单、钥匙、台账、语料与本机痕迹。')
