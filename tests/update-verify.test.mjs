import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { checkUpdate, verifySignature } from '../scripts/verify-update-artifacts.mjs'

// A throwaway key pair that produces signatures in the same format as `tauri signer`.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const keyId = Buffer.from('0a7737c4abe72542', 'hex')
const b64 = buffer => buffer.toString('base64')
const pubkey = b64(Buffer.from(`untrusted comment: minisign public key\n${b64(Buffer.concat([Buffer.from('Ed'), keyId, rawPublic]))}\n`))

function sign(data, id = keyId) {
  const hash = crypto.createHash('blake2b512').update(data).digest()
  const signature = crypto.sign(null, hash, privateKey)
  return b64(Buffer.from(`untrusted comment: signature\n${b64(Buffer.concat([Buffer.from('ED'), id, signature]))}\ntrusted comment: file:x\nglobal\n`))
}

const installer = Buffer.from('installer bytes')

test('a signature made with the app key verifies, anything else does not', () => {
  assert.equal(verifySignature(installer, sign(installer), pubkey), true)
  assert.equal(verifySignature(Buffer.from('a different installer'), sign(installer), pubkey), false)
  assert.equal(verifySignature(installer, sign(installer, Buffer.from('1122334455667788', 'hex')), pubkey), false)
})

test('a manifest must describe the signed installer and be usable', () => {
  const signatureText = sign(installer)
  const manifest = { version: '1.11.0', pub_date: '2026-11-28T10:00:00.000Z', platforms: { 'windows-x86_64': { url: 'https://example.com/a.exe', signature: signatureText } } }
  assert.deepEqual(checkUpdate({ installer, signatureText, manifest, pubkey, version: '1.11.0' }), [])
  const problems = checkUpdate({
    installer: Buffer.from('replaced after signing'), signatureText, pubkey, version: '1.11.0',
    manifest: { ...manifest, version: '1.10.0', pub_date: 'soon', platforms: { 'windows-x86_64': { url: 'http://example.com/a.exe', signature: 'other' } } },
  })
  assert.equal(problems.length, 5)
  assert.match(problems.join('\n'), /does not match its signature/)
  assert.match(problems.join('\n'), /expected 1\.11\.0/)
  assert.match(checkUpdate({ installer, signatureText, manifest: { version: '1.11.0', pub_date: '2026-11-28T10:00:00Z', platforms: {} }, pubkey })[0], /no windows-x86_64/)
})
