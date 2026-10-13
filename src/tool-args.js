/**
 * 模型参数的空占位归一化。
 *
 * DSH 工具 Schema 子集不支持 minLength/minItems/minimum，模型或第三方接口常把
 * 可选字段整体填成 ""、[]、{}、null 或 0。这些值不表达任何意图，却会触发执行层
 * 的严格校验并让 Agent 陷入循环。这里只删除“明确为空”的占位：
 * - null / undefined
 * - 去空白后为空的字符串
 * - 删除空字符串项后为空的数组（非空项保持原样，交给执行层严格校验）
 * - 递归清理后没有任何键（或只剩数字 0）的普通对象
 * - 显式列入 zeroFields 的整数 0（仅用于从 1 开始计数的字段）
 * 部分填写的对象、非空的非法值仍原样保留，由执行层报告具体错误。
 */

const isPlainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const isBlankString = (value) => typeof value === 'string' && value.trim() === ''

function cleanValue(value) {
  if (value === null || value === undefined) return undefined
  if (isBlankString(value)) return undefined
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null && item !== undefined && !isBlankString(item))
    return items.length ? items : undefined
  }
  if (isPlainObject(value)) {
    const cleaned = {}
    for (const [key, item] of Object.entries(value)) {
      const next = cleanValue(item)
      if (next !== undefined) cleaned[key] = next
    }
    // {position: 0} 这类只剩数字 0 的对象同样是整体占位（如空的 after 分页凭据）。
    return Object.values(cleaned).some((item) => item !== 0) ? cleaned : undefined
  }
  return value
}

/**
 * @param {unknown} args 模型原始参数
 * @param {{ zeroFields?: string[] }} [options]
 * @returns {unknown} 删除空占位后的新对象；非对象原样返回，交给调用方报错
 */
export function dropEmptyPlaceholders(args, { zeroFields = [] } = {}) {
  if (!isPlainObject(args)) return args
  const result = {}
  for (const [key, value] of Object.entries(args)) {
    if (zeroFields.includes(key) && value === 0) continue
    const next = cleanValue(value)
    if (next !== undefined) result[key] = next
  }
  return result
}
