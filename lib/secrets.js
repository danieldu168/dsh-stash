/**
 * 疑似密钥值检测 —— 由 Model Tool 与浏览器写端点共用，保证两边同一套标准。
 *
 * 只用**高置信度的厂商前缀特征**，不用"长且随机"这类熵启发式：
 * 后者会把 D:/data/archive-2024-quarterly-report 这种合法路径误判成密钥，
 * 误伤比漏报更糟。凭据引用名另有一条更严的格式约束（全大写 + 下划线）。
 *
 * @module dsh-stash/secrets
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,                        // OpenAI 风格
  /\bghp_[A-Za-z0-9]{20,}/,                        // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,                // Slack
  /\bAKIA[0-9A-Z]{16}\b/,                          // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/,                     // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
]

/** 凭据引用名必须是"环境变量风格"：全大写字母、数字、下划线，至少 3 位。 */
export const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/

export function looksLikeSecret(value) {
  if (typeof value !== 'string') return false
  return SECRET_PATTERNS.some((pattern) => pattern.test(value))
}

/** 递归扫描一个对象里所有字符串，返回第一条疑似口令的路径（无则 null）。 */
export function findSecretPath(value, path = '') {
  if (typeof value === 'string') return looksLikeSecret(value) ? path || '(根)' : null
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecretPath(value[index], `${path}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const found = findSecretPath(item, path ? `${path}.${key}` : key)
      if (found) return found
    }
  }
  return null
}
