import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { classify, findIdentity, loadConfig, main, ruleFor, seal, unseal } from './seal.mjs'

const cfg = {
  recipients: '.age-recipients',
  rules: [{ name: 'audit', root: 'docs/audits', include: ['**/*'], exclude: ['README.md', 'fixed/*.md'] }],
}

test('ruleFor seals everything under docs/audits except the public half', () => {
  for (const p of ['open/AUDIT-2026-01-01.md', 'ACCEPTED.md', 'open/.draft', 'fixed/poc.json'])
    assert.ok(ruleFor(cfg, `docs/audits/${p}`), p)
  for (const p of ['README.md', 'fixed/AUDIT-2026-01-01.md', 'open/AUDIT-2026-01-01.md.age'])
    assert.equal(ruleFor(cfg, `docs/audits/${p}`), null, p)
  assert.equal(ruleFor(cfg, 'README.md'), null)
})

test('the committed .sealed.json loads', () => {
  assert.equal(loadConfig(new URL('..', import.meta.url).pathname).rules[0].root, 'docs/audits')
})

// A fake cipher keeps the round trip free of any key material.
const fakeAge = {
  encrypt: (_r, plain, blob) => writeFileSync(blob, `ENC:${readFileSync(plain, 'utf8')}`),
  decrypt: (blob, id) => Buffer.from(String(blob).slice(4) + (id ? '' : '?')),
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cpp-seal-test-'))
  mkdirSync(join(root, 'docs/audits/open'), { recursive: true })
  let state = {}
  const logs = []
  const deps = {
    log: m => logs.push(m),
    age: fakeAge,
    readState: () => state,
    writeState: s => {
      state = s
    },
    staged: () => [],
    add: () => {},
  }
  return { root, deps, logs, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('seal then edit then unseal: edited seals, a changed blob unseals, both = conflict', () => {
  const { root, deps, cleanup } = fixture()
  try {
    const plain = join(root, 'docs/audits/open/A.md')
    writeFileSync(plain, 'one')
    assert.deepEqual(seal(root, cfg, deps), ['docs/audits/open/A.md'])
    assert.equal(classify(root, cfg, deps.readState())[0].state, 'ok')
    writeFileSync(plain, 'two')
    assert.equal(classify(root, cfg, deps.readState())[0].state, 'edited')
    seal(root, cfg, deps)
    writeFileSync(`${plain}.age`, 'ENC:three')
    assert.equal(classify(root, cfg, deps.readState())[0].state, 'changed')
    assert.deepEqual(unseal(root, cfg, deps, 'id').unsealed, ['docs/audits/open/A.md'])
    assert.equal(readFileSync(plain, 'utf8'), 'three')
    writeFileSync(plain, 'local')
    writeFileSync(`${plain}.age`, 'ENC:upstream')
    assert.equal(classify(root, cfg, deps.readState())[0].state, 'conflict')
    assert.deepEqual(unseal(root, cfg, deps, 'id').conflicts, ['docs/audits/open/A.md'])
    assert.equal(readFileSync(plain, 'utf8'), 'local')
  } finally {
    cleanup()
  }
})

test('the pre-commit hook refuses staged plaintext and fails closed when git fails', () => {
  const { root, deps, logs, cleanup } = fixture()
  try {
    writeFileSync(
      join(root, '.sealed.json'),
      JSON.stringify({ recipients: '.age-recipients', rules: cfg.rules }),
    )
    assert.equal(
      main(['hook-pre-commit'], { root, deps: { ...deps, staged: () => ['docs/audits/open/A.md'] } }),
      1,
    )
    assert.match(logs.join('\n'), /REFUSING/)
    assert.equal(main(['hook-pre-commit'], { root, deps: { ...deps, staged: () => null } }), 1)
    assert.equal(main(['hook-pre-commit'], { root, deps }), 0)
  } finally {
    cleanup()
  }
})

test('findIdentity prefers the environment, then the file, then the keychain', () => {
  assert.equal(
    findIdentity({ AGE_IDENTITY: 'a' }, () => 'k'),
    'a',
  )
  assert.equal(
    findIdentity({}, () => 'k'),
    'k',
  )
})
