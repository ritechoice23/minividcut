// Builds the static `latest.json` the Tauri updater reads from GitHub Releases.
// Kept separate from the build so the manifest can be regenerated for an
// already-built installer without rebuilding the app.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      args[key] = 'true'
    } else {
      args[key] = value
      index += 1
    }
  }
  return args
}

export function buildUpdateManifest({
  installerName,
  signature,
  version,
  tag,
  notes,
  date,
  repository = 'ritechoice23/minividcut',
}) {
  if (!installerName || !signature || !version) {
    throw new Error('installerName, signature and version are required')
  }
  const cleanVersion = String(version).replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+/.test(cleanVersion)) {
    throw new Error(`Invalid version: ${version}`)
  }
  const cleanSignature = signature.trim()
  if (!cleanSignature) throw new Error('The updater signature is empty')

  return {
    version: cleanVersion,
    notes: notes || `MiniVidCut ${cleanVersion} is ready. See the release page for details.`,
    pub_date: date || new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: cleanSignature,
        url: `https://github.com/${repository}/releases/download/${tag || `v${cleanVersion}`}/${installerName}`,
      },
    },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const name of ['installer', 'signature', 'version']) {
    if (!args[name]) throw new Error(`Missing required argument: --${name}`)
  }

  const manifest = buildUpdateManifest({
    installerName: basename(args.installer),
    signature: readFileSync(args.signature, 'utf8'),
    version: args.version,
    tag: args.tag,
    notes: args.notes,
    date: args.date,
    repository: args.repository || process.env.GITHUB_REPOSITORY,
  })

  const output = args.out || resolve(dirname(args.installer), 'latest.json')
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${output}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
