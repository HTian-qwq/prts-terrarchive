import { createRequire } from 'node:module'

const packageMetadata = createRequire(import.meta.url)('../package.json')

export const AGENT_VERSION = packageMetadata.version

function parseIdentifierList(value, { prerelease = false } = {}) {
  if (value === '') return null
  const identifiers = value.split('.')
  if (identifiers.some((identifier) => !/^[0-9A-Za-z-]+$/u.test(identifier)
      || (prerelease && /^\d+$/u.test(identifier)
        && identifier.length > 1 && identifier.startsWith('0')))) return null
  return identifiers
}

/** Parse one strict Semantic Version 2.0.0 value without numeric precision loss. */
export function parseSemver(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
      || value.trim() !== value) return null
  const plus = value.indexOf('+')
  if (plus !== -1 && value.indexOf('+', plus + 1) !== -1) return null
  const coreAndPrerelease = plus === -1 ? value : value.slice(0, plus)
  const buildText = plus === -1 ? null : value.slice(plus + 1)
  const dash = coreAndPrerelease.indexOf('-')
  const core = dash === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, dash)
  const prereleaseText = dash === -1 ? null : coreAndPrerelease.slice(dash + 1)
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(core)
  const prerelease = prereleaseText == null
    ? [] : parseIdentifierList(prereleaseText, { prerelease: true })
  const build = buildText == null ? [] : parseIdentifierList(buildText)
  if (!match || prerelease == null || build == null) return null
  return Object.freeze({ raw: value, core: Object.freeze(match.slice(1)),
    prerelease: Object.freeze(prerelease), build: Object.freeze(build) })
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

/** Compare strict SemVer values. Build metadata intentionally has no precedence. */
export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue)
  const right = parseSemver(rightValue)
  if (!left || !right) throw new TypeError('版本必须是有效的 Semantic Version 2.0.0')
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumericIdentifiers(left.core[index], right.core[index])
    if (compared) return compared
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length ? -1 : 1
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier == null || rightIdentifier == null) {
      return leftIdentifier == null ? -1 : 1
    }
    const leftNumeric = /^\d+$/u.test(leftIdentifier)
    const rightNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      const compared = compareNumericIdentifiers(leftIdentifier, rightIdentifier)
      if (compared) return compared
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (leftIdentifier !== rightIdentifier) {
      return leftIdentifier < rightIdentifier ? -1 : 1
    }
  }
  return 0
}
