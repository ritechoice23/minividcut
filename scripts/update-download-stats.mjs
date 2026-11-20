// Refreshes docs/download-stats.json from GitHub's release asset metrics.
//
// GitHub counts a download per release-asset fetch. That includes the
// `latest.json` manifest the updater fetches on every app launch and the
// FFmpeg source archives, so the raw "all assets" number is not a useful
// measure of app downloads. Only installer assets are counted as downloads.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OWNER = 'ritechoice23'
const REPO = 'minividcut'
const OUTPUT = 'docs/download-stats.json'
const INSTALLER_NAME = /^MiniVidCut_.*-setup\.exe$/

export function summarizeReleases(releases) {
  const perRelease = releases.map(release => {
    const installers = release.assets.filter(asset => INSTALLER_NAME.test(asset.name))
    return {
      tag: release.tag_name,
      installerDownloads: installers.reduce((sum, asset) => sum + asset.download_count, 0),
    }
  })

  return {
    installerDownloads: perRelease.reduce((sum, release) => sum + release.installerDownloads, 0),
    assetDownloads: releases.reduce((sum, release) =>
      sum + release.assets.reduce((total, asset) => total + asset.download_count, 0), 0),
    installerAssets: releases.reduce((sum, release) =>
      sum + release.assets.filter(asset => INSTALLER_NAME.test(asset.name)).length, 0),
    releases: perRelease,
  }
}

async function fetchReleases() {
  const releases = []
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'minividcut-download-stats',
          ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        },
      },
    )
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`)
    const batch = await response.json()
    releases.push(...batch)
    if (batch.length < 100) break
  }
  return releases
}

function main() {
  const releases = fetchReleases()
  return releases.then(all => {
    const stats = summarizeReleases(all)
    writeFileSync(OUTPUT, `${JSON.stringify({ ...stats, updatedAt: new Date().toISOString() }, null, 2)}\n`)
    console.log(`${stats.installerDownloads} installer downloads across all releases`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
