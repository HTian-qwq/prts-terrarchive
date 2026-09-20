/** Versioned optional attachment to endfield_official_game. */
export const LOCALIZATION_ALGORITHM = 'prts-official-localization-v1'
export const LOCALIZATION_LANGUAGES = Object.freeze([
  'CN', 'EN', 'JP', 'KR', 'TC', 'MX', 'BR', 'FR', 'DE', 'RU', 'IT', 'ID', 'TH', 'VN',
])

export function localizationAssets(pack, fail = (message) => { throw new Error(message) }) {
  const value = pack.localization
  if (value == null) return []
  if (value.algorithm !== LOCALIZATION_ALGORITHM || value.schema_version !== 1
      || value.game !== 'endfield' || value.source_language !== 'CN'
      || typeof value.game_version !== 'string' || !value.game_version
      || value.game_version !== pack.game_version
      || !Number.isSafeInteger(value.text_count) || value.text_count < 1 || value.text_count > 1_000_000
      || value.catalog?.path !== 'localization/catalog.jsonl.gz'
      || !value.languages || typeof value.languages !== 'object' || Array.isArray(value.languages)
      || !value.languages.CN || Object.keys(value.languages).some((language) =>
        !LOCALIZATION_LANGUAGES.includes(language)
        || value.languages[language]?.path !== `localization/${language}.jsonl.gz`)) {
    fail('官方本地化附件元数据无效或版本不一致')
  }
  return [value.catalog, ...Object.values(value.languages)]
}
