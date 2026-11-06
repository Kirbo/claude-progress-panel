import type { MessageKey } from '../locales/en'
import { en } from '../locales/en'

const CATALOGS: Record<string, Record<MessageKey, string>> = { en }

/** Looks a key up in the catalog and fills `{name}` placeholders. English is the only catalog yet. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}, lang = 'en'): string {
  const template = (CATALOGS[lang] ?? en)[key]
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
