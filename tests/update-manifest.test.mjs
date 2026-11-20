import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUpdateManifest, parseArgs } from '../scripts/create-update-manifest.mjs'

test('update manifest points at the signed installer with its signature inline', () => {
  const manifest = buildUpdateManifest({
    installerName: 'MiniVidCut_1.3.0_x64-setup.exe',
    signature: 'dW50cnVzdGVkIGNvbW1lbnQ6...\n',
    version: 'v1.3.0',
    notes: 'New editing tools',
    date: '2026-11-20T10:00:00.000Z',
  })

  assert.equal(manifest.version, '1.3.0')
  assert.equal(manifest.notes, 'New editing tools')
  assert.equal(manifest.pub_date, '2026-11-20T10:00:00.000Z')
  assert.deepEqual(manifest.platforms, {
    'windows-x86_64': {
      signature: 'dW50cnVzdGVkIGNvbW1lbnQ6...',
      url: 'https://github.com/ritechoice23/minividcut/releases/download/v1.3.0/MiniVidCut_1.3.0_x64-setup.exe',
    },
  })
})

test('update manifest uses safe defaults and honours a custom tag and repository', () => {
  const manifest = buildUpdateManifest({
    installerName: 'MiniVidCut_2.0.0_x64-setup.exe',
    signature: 'sig',
    version: '2.0.0',
    tag: 'release-2',
    repository: 'owner/other-repo',
  })

  assert.match(manifest.pub_date, /^\d{4}-\d\d-\d\dT/)
  assert.equal(manifest.notes, 'MiniVidCut 2.0.0 is ready. See the release page for details.')
  assert.equal(manifest.platforms['windows-x86_64'].url,
    'https://github.com/owner/other-repo/releases/download/release-2/MiniVidCut_2.0.0_x64-setup.exe')
})

test('update manifest rejects incomplete or malformed inputs', () => {
  assert.throws(() => buildUpdateManifest({ signature: 'sig', version: '1.0.0' }), /required/)
  assert.throws(() => buildUpdateManifest({ installerName: 'a.exe', signature: 'sig', version: 'next' }), /version/i)
  assert.throws(() => buildUpdateManifest({ installerName: 'a.exe', signature: '  ', version: '1.0.0' }), /signature/i)
})

test('CLI arguments are parsed into a flat map', () => {
  assert.deepEqual(parseArgs(['--installer', 'setup.exe', '--version', '1.3.0', '--clobber']), {
    installer: 'setup.exe',
    version: '1.3.0',
    clobber: 'true',
  })
})
