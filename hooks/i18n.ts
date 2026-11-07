import type { MessageKey } from '../locales/en'
import { en } from '../locales/en'

const CATALOGS: Record<string, Record<MessageKey, string>> = { en }

/** Looks a key up in the catalog and fills `{name}` placeholders. English is the only catalog yet. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}, lang = 'en'): string {
  const template = (CATALOGS[lang] ?? en)[key]
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

/** A key with `_one` / `_other` forms (English plural rules): its base name. */
type PluralBase = { [K in MessageKey]: K extends `${infer B}_one` ? B : never }[MessageKey]

/** The `_one` or `_other` form of a plural key for `count`, with `{count}` filled. */
export function tn(
  base: PluralBase,
  count: number,
  vars: Record<string, string | number> = {},
  lang = 'en',
): string {
  return t(`${base}_${count === 1 ? 'one' : 'other'}` as MessageKey, { count, ...vars }, lang)
}
