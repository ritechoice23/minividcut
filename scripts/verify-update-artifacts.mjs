// Checks the files that make up an in-app update before they are published:
// the installer's signature must verify against the public key baked into the
// app, and the manifest must describe exactly that installer. A mismatch here is
// what makes every installed copy report "update failed".
//
//   node scripts/verify-update-artifacts.mjs --installer <setup.exe> --signature <setup.exe.sig> \
//     [--manifest latest.json] [--config src-tauri/tauri.conf.json] [--version 1.11.0]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** Minisign files are a comment line followed by base64 data. */
function minisignBytes(text) {
  const line = text.split(/\r?\n/)[1]
  if (!line) throw new Error('The minisign data is missing.')
  return Buffer.from(line.trim(), 'base64')
}

export function parsePublicKey(pubkeyBase64) {
  const bytes = minisignBytes(Buffer.from(pubkeyBase64, 'base64').toString())
  if (bytes.length !== 42) throw new Error('The public key is not a minisign key.')
  return { id: bytes.subarray(2, 10), key: bytes.subarray(10, 42) }
}

export function parseSignature(signatureBase64) {
  const bytes = minisignBytes(Buffer.from(signatureBase64.trim(), 'base64').toString())
  if (bytes.length !== 74) throw new Error('The signature is not a minisign signature.')
  return { algorithm: bytes.subarray(0, 2).toString(), id: bytes.subarray(2, 10), signature: bytes.subarray(10, 74) }
}

/** True when `signatureBase64` signs `data` with the key in `pubkeyBase64`. */
export function verifySignature(data, signatureBase64, pubkeyBase64) {
  const pub = parsePublicKey(pubkeyBase64)
  const sig = parseSignature(signatureBase64)
  if (!pub.id.equals(sig.id)) return false
  const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub.key]), format: 'der', type: 'spki' })
  // "ED" signatures cover the BLAKE2b-512 hash of the file, "Ed" ones the file itself.
  const message = sig.algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data
  return crypto.verify(null, message, key, sig.signature)
}

/** Everything that must be true for installed apps to accept this update. */
export function checkUpdate({ installer, signatureText, manifest, pubkey, version }) {
  const problems = []
  if (!verifySignature(installer, signatureText, pubkey)) {
    problems.push('The installer does not match its signature for the app’s public key. Installed apps will reject it.')
  }
  if (manifest) {
    const platform = manifest.platforms?.['windows-x86_64']
    if (!platform) problems.push('The manifest has no windows-x86_64 entry.')
    else {
      if (platform.signature?.trim() !== signatureText.trim()) problems.push('The manifest signature differs from the .sig file.')
      if (!/^https:\/\//.test(platform.url ?? '')) problems.push('The manifest installer address is not an https link.')
    }
    if (version && manifest.version !== version) problems.push(`The manifest says version ${manifest.version}, expected ${version}.`)
    if (Number.isNaN(Date.parse(manifest.pub_date ?? ''))) problems.push('The manifest pub_date is not a valid date.')
  }
  return problems
}

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = args(process.argv.slice(2))
  if (!options.installer || !options.signature) {
    console.error('Usage: node scripts/verify-update-artifacts.mjs --installer <setup.exe> --signature <setup.exe.sig> [--manifest latest.json] [--config tauri.conf.json] [--version x.y.z]')
    process.exit(2)
  }
  const config = JSON.parse(fs.readFileSync(options.config ?? 'src-tauri/tauri.conf.json', 'utf8'))
  const problems = checkUpdate({
    installer: fs.readFileSync(options.installer),
    signatureText: fs.readFileSync(options.signature, 'utf8'),
    manifest: options.manifest ? JSON.parse(fs.readFileSync(options.manifest, 'utf8')) : undefined,
    pubkey: config.plugins.updater.pubkey,
    version: options.version,
  })
  if (problems.length) {
    for (const problem of problems) console.error(`✖ ${problem}`)
    process.exit(1)
  }
  console.log('✔ The installer, its signature and the manifest agree. Installed apps will accept this update.')
}
