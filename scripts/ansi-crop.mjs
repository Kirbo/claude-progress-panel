#!/usr/bin/env node
// Crops an ANSI screen capture (`tmux capture-pane -e -p`) to a column range and row range, keeping
// the colour codes (SGR) and dropping other escapes (OSC 8 hyperlinks and the like), for the README
// screenshots (CLAUDE.md "Screenshots").
//   node scripts/ansi-crop.mjs <capture.ansi> <fromCol> <width> <topRow> <bottomRow> > pane.ansi
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

export function crop(text, from, width, top, bottom) {
  return text
    .split('\n')
    .slice(top, bottom)
    .map(line => cropLine(line, from, width))
    .join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, from, width, top, bottom] = process.argv.slice(2)
  process.stdout.write(
    crop(readFileSync(file, 'utf8'), Number(from), Number(width), Number(top), Number(bottom)),
  )
}
