#!/usr/bin/env node
// Crops an ANSI screen capture (`tmux capture-pane -e -p`) to a column range and row range, keeping
// the colour codes (SGR) and dropping other escapes (OSC 8 hyperlinks and the like), for the README
// screenshots (CLAUDE.md "Screenshots").
//   node scripts/ansi-crop.mjs <capture.ansi> <fromCol> <width> <topRow> <bottomRow> > pane.ansi
//   node scripts/ansi-crop.mjs --print-bg pane.ansi   # the pane's background, for freeze --background
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
// An escape: a CSI sequence (`ESC [ … letter`, colours among them) or an OSC one (`ESC ] … BEL|ST`).
const ESCAPE = new RegExp(`^${ESC}(\\[[0-9;:?]*[A-Za-z]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\))`)

/** One line → its columns [from, from + width), every colour code kept, other escapes dropped. */
export function cropLine(line, from, width) {
  let col = 0
  let out = ''
  for (let i = 0; i < line.length; ) {
    const esc = line[i] === ESC ? ESCAPE.exec(line.slice(i)) : null
    if (esc) {
      if (esc[1].startsWith('[')) out += esc[0]
      i += esc[0].length
      continue
    }
    const ch = String.fromCodePoint(line.codePointAt(i))
    if (col >= from && col < from + width) out += ch
    col += 1
    i += ch.length
  }
  return `${out}\x1b[0m`
}

const BASE16 = [
  '#000000',
  '#800000',
  '#008000',
  '#808000',
  '#000080',
  '#800080',
  '#008080',
  '#c0c0c0',
  '#808080',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#0000ff',
  '#ff00ff',
  '#00ffff',
  '#ffffff',
]
const hex2 = n => n.toString(16).padStart(2, '0')

/** An xterm 256-colour index as #rrggbb. */
export function xterm256(n) {
  if (n < 16) return BASE16[n]
  if (n >= 232) {
    const v = 8 + 10 * (n - 232)
    return `#${hex2(v)}${hex2(v)}${hex2(v)}`
  }
  const steps = [0, 95, 135, 175, 215, 255]
  const i = n - 16
  return `#${hex2(steps[Math.floor(i / 36)])}${hex2(steps[Math.floor(i / 6) % 6])}${hex2(steps[i % 6])}`
}

/**
 * The background colour a capture uses most (the pane's own), as #rrggbb — the renderer's canvas
 * takes it, so the screenshot's empty cells match the text cells. Undefined when none is set.
 */
export function dominantBackground(text) {
  const counts = new Map()
  for (const m of text.matchAll(new RegExp(`${ESC}\\[([0-9;]*)m`, 'g'))) {
    const p = (m[1] ?? '').split(';')
    for (let i = 0; i < p.length; i++) {
      let colour
      if (p[i] === '48' && p[i + 1] === '5') colour = xterm256(Number(p[i + 2]))
      else if (p[i] === '48' && p[i + 1] === '2')
        colour = `#${hex2(Number(p[i + 2]))}${hex2(Number(p[i + 3]))}${hex2(Number(p[i + 4]))}`
      if (colour) counts.set(colour, (counts.get(colour) ?? 0) + 1)
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

export function crop(text, from, width, top, bottom) {
  return text
    .split('\n')
    .slice(top, bottom)
    .map(line => cropLine(line, from, width))
    .join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === '--print-bg') {
  // `node scripts/ansi-crop.mjs --print-bg pane.ansi` → the colour to give the renderer's canvas.
  process.stdout.write(dominantBackground(readFileSync(process.argv[3] ?? '', 'utf8')) ?? '')
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, from, width, top, bottom] = process.argv.slice(2)
  process.stdout.write(
    crop(readFileSync(file, 'utf8'), Number(from), Number(width), Number(top), Number(bottom)),
  )
}
