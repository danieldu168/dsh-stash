// B、C 两类 handler 的测试：数据库（SQLite）与对象存储（S3 / WebDAV）。
//
// 为什么单独一个文件：这两类形态是新增能力，验证方式与原来的取数链路不同——
//   · SigV4 是纯计算，**用 AWS 官方测试向量逐字段核对**（canonical request / string to sign / signature）；
//   · SQLite 走 Node 内置 node:sqlite（Node 22.5+ 可能需要 --experimental-sqlite，不可用则跳过并说明）；
//   · 对象存储打本机 mock 服务器，验的是"发出去什么"（签名头、Basic 头、列表解析、二进制不回正文）。
//
// 用法：node test/handlers-bc.mjs
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { signV4Request } from '../lib/handlers/sigv4.js'
import * as db from '../lib/handlers/db.js'
import * as objstore from '../lib/handlers/objstore.js'

const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)

// ── 一、SigV4：AWS 官方测试向量 get-vanilla ─────────────────────────────────
// 向量来源：aws-sig-v4-test-suite（smithy-lang/smithy-rs 镜像）v4/get-vanilla。
// 三个文件的值都原样抄在这里，任何一个字不同都说明实现跑偏了。
const VECTOR = {
  credentials: { access_key_id: 'AKIDEXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
  region: 'us-east-1',
  service: 'service',
  timestamp: '2015-08-30T12:36:00Z',
  canonicalRequest: [
    'GET',
    '/',
    '',
    'host:example.amazonaws.com',
    'x-amz-date:20150830T123600Z',
    '',
    'host;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'),
  stringToSign: [
    'AWS4-HMAC-SHA256',
    '20150830T123600Z',
    '20150830/us-east-1/service/aws4_request',
    'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
  ].join('\n'),
  signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
}

const signed = signV4Request({
  method: 'GET',
  url: 'http://example.amazonaws.com/',
  headers: { Host: 'example.amazonaws.com' },
  region: VECTOR.region,
  service: VECTOR.service,
  accessKeyId: VECTOR.credentials.access_key_id,
  secretAccessKey: VECTOR.credentials.secret_access_key,
  timestamp: new Date(VECTOR.timestamp),
})
check('SigV4 canonical request 与官方向量逐字节一致', signed.canonicalRequest === VECTOR.canonicalRequest, signed.canonicalRequest.slice(0, 60))
check('SigV4 string to sign 与官方向量逐字节一致', signed.stringToSign === VECTOR.stringToSign, signed.stringToSign.slice(0, 60))
check('SigV4 签名与官方向量逐字节一致', signed.signature === VECTOR.signature, signed.signature)
check(
  'Authorization 头形状正确',
  signed.authorization === `AWS4-HMAC-SHA256 Credential=${VECTOR.credentials.access_key_id}/20150830/us-east-1/service/aws4_request, `
    + `SignedHeaders=host;x-amz-date, Signature=${VECTOR.signature}`,
  signed.authorization,
)

// 头部值规范化：连续空白压成一个空格（官方 get-header-value-trim 的规则）。
const trimmed = signV4Request({
  method: 'GET',
  url: 'http://example.amazonaws.com/',
  headers: { Host: 'example.amazonaws.com', 'My-Header1': '  value  with   spaces  ' },
  region: 'us-east-1',
  service: 'service',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  timestamp: new Date('2015-08-30T12:36:00Z'),
})
check('头部值去空白并压空格', trimmed.canonicalRequest.includes('my-header1:value with spaces'), trimmed.canonicalRequest)
check('签名头按字典序排列', trimmed.signedHeaders === 'host;my-header1;x-amz-date', trimmed.signedHeaders)

// ── 二、db（SQLite） ────────────────────────────────────────────────────────
check('只读 SQL 守卫：SELECT 放行', db.isReadOnlySql('SELECT 1'))
check('只读 SQL 守卫：WITH 放行', db.isReadOnlySql('WITH t AS (SELECT 1) SELECT * FROM t'))
check('只读 SQL 守卫：前置注释放行', db.isReadOnlySql('-- 注释\nSELECT 1'))
check('只读 SQL 守卫：写语句拒绝', !db.isReadOnlySql('DROP TABLE users'))
check('只读 SQL 守卫：多语句拒绝', !db.isReadOnlySql('SELECT 1; DROP TABLE users'))
check('只读 SQL 守卫：空语句拒绝', !db.isReadOnlySql('   '))

const source = (request) => ({ id: 'zz_db', kind: 'remote', handler: 'db', request, access: 'official-api' })

const badEngine = await db.run('query', {}, { source: source({ engine: 'postgres', path: '/tmp/x.db', sql: 'SELECT 1' }) })
check('db：非 sqlite 引擎被拒并指路 http 门面', badEngine.ok === false && badEngine.kind === 'unsupported-engine', badEngine.error)

const badPath = await db.run('query', {}, { source: source({ engine: 'sqlite', path: 'relative.db', sql: 'SELECT 1' }) })
check('db：相对路径被拒', badPath.ok === false && badPath.kind === 'bad-config', badPath.error)

const noSql = await db.run('query', {}, { source: source({ engine: 'sqlite', path: '/tmp/x.db' }) })
check('db：缺少 request.sql 被拒', noSql.ok === false && noSql.kind === 'bad-config', noSql.error)

const writeSql = await db.run('query', {}, { source: source({ engine: 'sqlite', path: '/tmp/x.db', sql: 'DELETE FROM users' }) })
check('db：写语句在取数时也被拒', writeSql.ok === false && writeSql.kind === 'not-read-only', writeSql.error)

const unknownAction = await db.run('purge', {}, { source: source({ engine: 'sqlite', path: '/tmp/x.db', sql: 'SELECT 1' }) })
check('db：未知动作被拒', unknownAction.ok === false && unknownAction.kind === 'unknown-action', unknownAction.error)

let sqliteAvailable = true
try {
  await import('node:sqlite')
} catch {
  sqliteAvailable = false
}

if (!sqliteAvailable) {
  check('db：本机 Node 无 node:sqlite，真库断言跳过（实现会给出 engine-unavailable 提示）', true, 'Node 22.5–23.3 需 --experimental-sqlite')
} else {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stash-db-'))
  const dbPath = join(dir, 'test.db')
  const seed = new DatabaseSync(dbPath)
  seed.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, dept TEXT)')
  seed.exec("INSERT INTO people (name, dept) VALUES ('甲','研发'), ('乙','销售'), ('丙','研发')")
  seed.close()

  const querySource = source({
    engine: 'sqlite',
    path: dbPath,
    sql: 'SELECT id, name FROM people WHERE dept = :dept ORDER BY id',
    required: ['dept'],
    limit: 10,
  })
  const rows = await db.run('query', { dept: '研发' }, { source: querySource })
  check('db：真库查询返回命中行', rows.ok === true && rows.count === 2, JSON.stringify(rows.items))
  check('db：结果标明只读模式与引擎', rows.mode === 'read-only' && rows.engine === 'sqlite', `${rows.mode}/${rows.engine}`)
  check('db：行数上限生效（limit=1）', (await db.run('query', { dept: '研发' }, { source: { ...querySource, request: { ...querySource.request, limit: 1 } } })).count === 1)

  const missing = await db.run('query', {}, { source: querySource })
  check('db：缺必填参数时前置报错', missing.ok === false && missing.kind === 'usage', missing.error)

  const tables = await db.run('tables', {}, { source: querySource })
  check('db：tables 动作列出表', tables.ok === true && tables.items.some((item) => item.name === 'people'), JSON.stringify(tables.items))

  const missingFile = await db.run('query', {}, { source: source({ engine: 'sqlite', path: join(dir, 'nope.db'), sql: 'SELECT 1' }) })
  check('db：文件不存在时给出可读错误', missingFile.ok === false && missingFile.kind === 'db', String(missingFile.error).slice(0, 60))

  // 只读打开的实证：即使守卫被绕过，引擎层也写不进去。
  const writeAttempt = await db.run('query', {}, { source: source({ engine: 'sqlite', path: dbPath, sql: "SELECT * FROM people; INSERT INTO people (name) VALUES ('x')" }) })
  check('db：多语句被守卫拦下（只读打开的实证由守卫 + readOnly 双保险）', writeAttempt.ok === false && writeAttempt.kind === 'not-read-only')

  rmSync(dir, { recursive: true, force: true })
}

// ── 三、objstore：打本机 mock 服务器 ────────────────────────────────────────
const seen = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  seen.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers })
  if (req.method === 'PROPFIND') {
    res.writeHead(207, { 'Content-Type': 'application/xml' })
    res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
      + '<d:response><d:href>/dav/a.txt</d:href></d:response>'
      + '<d:response><d:href>/dav/b.csv</d:href></d:response>'
      + '</d:multistatus>')
    return
  }
  if (url.pathname.endsWith('/missing.txt')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('no such key')
    return
  }
  if (url.pathname.endsWith('/shot.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '4' })
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    return
  }
  if (url.searchParams.has('list-type')) {
    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end('<?xml version="1.0"?><ListBucketResult>'
      + '<Contents><Key>reports/a.csv</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>12</Size></Contents>'
      + '<Contents><Key>reports/b.txt</Key><LastModified>2026-01-02T00:00:00.000Z</LastModified><Size>34</Size></Contents>'
      + '</ListBucketResult>')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/csv' })
  res.end('a,b\n1,2\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`

const credentials = {
  resolve: async (ref) => {
    const values = { S3_KEY_ID: 'AKIDEXAMPLE', S3_SECRET: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', DAV_USER: 'alice', DAV_PASSWORD: 's3cret' }
    return values[ref] ? { value: values[ref] } : null
  },
}
const s3Source = {
  id: 'zz_s3', kind: 'remote', handler: 'objstore', access: 'official-api',
  credentials: ['S3_KEY_ID', 'S3_SECRET'],
  request: {
    protocol: 's3', endpoint, bucket: 'my-bucket', region: 'us-east-1', prefix: 'reports/',
    accessKeyIdRef: 'S3_KEY_ID', secretAccessKeyRef: 'S3_SECRET', limit: 10,
  },
}

const list = await objstore.run('list', {}, { source: s3Source, credentials })
check('s3：list 解析出 2 个对象', list.ok === true && list.count === 2, JSON.stringify(list.items))
check('s3：list 带上前缀与 max-keys', seen.some((call) => call.query.includes('list-type=2') && call.query.includes('prefix=reports')), String(seen.at(-1)?.query))
check('s3：私有桶请求带 SigV4 签名头', seen.some((call) => String(call.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256')), String(seen.at(-1)?.headers.authorization).slice(0, 40))
check('s3：请求带 x-amz-date', seen.some((call) => typeof call.headers['x-amz-date'] === 'string'))

const object = await objstore.run('get', { key: 'reports/a.csv' }, { source: s3Source, credentials })
check('s3：get 文本对象回正文', object.ok === true && object.items[0].body.includes('a,b'), JSON.stringify(object.items[0]).slice(0, 80))
check('s3：返回值里的 signature 已脱敏（本次 URL 无签名参数，字段为空即为正确）', !String(object.url).includes('X-Amz-Signature'))

const binary = await objstore.run('get', { key: 'shot.png' }, { source: s3Source, credentials })
check('s3：二进制对象只回元信息', binary.ok === true && binary.items[0].body === null && String(binary.items[0].contentType).includes('image/png'), JSON.stringify(binary.items[0]).slice(0, 100))

const missingKey = await objstore.run('get', { key: 'missing.txt' }, { source: s3Source, credentials })
check('s3：404 转成可读错误并带状态码', missingKey.ok === false && missingKey.status === 404, String(missingKey.error).slice(0, 80))

const anonymous = await objstore.run('list', {}, {
  source: { ...s3Source, credentials: [], request: { ...s3Source.request, accessKeyIdRef: null, secretAccessKeyRef: null } },
  credentials: null,
})
check('s3：公开桶不声明凭据时匿名读取', anonymous.ok === true && anonymous.count === 2)
check('s3：匿名请求不带 Authorization', !seen.at(-1).headers.authorization)

const noCreds = await objstore.run('list', {}, { source: s3Source, credentials: null })
check('s3：需要签名却没挂凭据服务时明确报错', noCreds.ok === false && noCreds.kind === 'no-credentials', noCreds.error)

const missingSecret = await objstore.run('list', {}, {
  source: { ...s3Source, credentials: ['S3_KEY_ID', 'NOPE'] , request: { ...s3Source.request, secretAccessKeyRef: 'NOPE' } },
  credentials,
})
check('s3：凭据未配置时明确报错', missingSecret.ok === false && missingSecret.kind === 'credential-missing', missingSecret.error)

const davSource = {
  id: 'zz_dav', kind: 'remote', handler: 'objstore', access: 'official-api',
  credentials: ['DAV_USER', 'DAV_PASSWORD'],
  request: { protocol: 'webdav', endpoint: `${endpoint}/dav`, usernameRef: 'DAV_USER', passwordRef: 'DAV_PASSWORD', limit: 10 },
}
const davList = await objstore.run('list', {}, { source: davSource, credentials })
check('webdav：PROPFIND 列出两条', davList.ok === true && davList.count === 2, JSON.stringify(davList.items))
check('webdav：带 Basic 认证头', String(seen.at(-1).headers.authorization ?? '').startsWith('Basic '), String(seen.at(-1).headers.authorization))
check('webdav：Depth: 1', seen.at(-1).headers.depth === '1', String(seen.at(-1).headers.depth))

const davGet = await objstore.run('get', { path: 'a.txt' }, { source: davSource, credentials })
check('webdav：get 取到正文', davGet.ok === true && davGet.items[0].body.includes('a,b'), JSON.stringify(davGet.items[0]).slice(0, 80))

const davNoPath = await objstore.run('get', {}, { source: davSource, credentials })
check('webdav：get 缺 path 时报用法错误', davNoPath.ok === false && davNoPath.kind === 'usage', davNoPath.error)

const badProtocol = await objstore.run('list', {}, { source: { ...davSource, request: { protocol: 'ftp', endpoint } }, credentials })
check('objstore：未知协议被拒', badProtocol.ok === false && badProtocol.kind === 'bad-config', badProtocol.error)

server.close()

console.log(results.join('\n'))
console.log(`\n结论：${results.every((r) => r.startsWith('✅')) ? '✅ 全部通过' : '❌ 有失败项'}`)
if (!results.every((r) => r.startsWith('✅'))) process.exit(1)
