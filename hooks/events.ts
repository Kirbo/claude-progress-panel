// The classic hook events and tool inputs as the plugin reads them: the engine types them loosely
// (they are Claude Code's own payloads, and grow), so every field is unknown until checked.

/** An event (or a nested part of one) as a record of unknowns; anything that is no object reads as empty. */
export function fields(e: unknown): Record<string, unknown> {
  return typeof e === 'object' && e !== null && !Array.isArray(e) ? (e as Record<string, unknown>) : {}
}

/** A field that is a non-empty string, else undefined. */
export function text(e: unknown, key: string): string | undefined {
  const value = fields(e)[key]
  return typeof value === 'string' && value ? value : undefined
}
