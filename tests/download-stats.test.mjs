import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeReleases } from '../scripts/update-download-stats.mjs'

const asset = (name, download_count) => ({ name, download_count })
const release = (tag_name, assets) => ({ tag_name, assets })

test('installer downloads are summed across releases without counting other assets', () => {
  const stats = summarizeReleases([
    release('v1.3.0', [
      asset('MiniVidCut_1.3.0_x64-setup.exe', 4),
      asset('MiniVidCut_1.3.0_x64-setup.exe.sig', 9),
      asset('latest.json', 1200),
    ]),
    release('v1.2.0', [
      asset('MiniVidCut_1.2.0_x64-setup.exe', 3),
      asset('ffmpeg-sources.zip', 2),
    ]),
  ])

  assert.equal(stats.installerDownloads, 7)
  assert.equal(stats.assetDownloads, 1218)
  assert.equal(stats.installerAssets, 2)
  assert.deepEqual(stats.releases, [
    { tag: 'v1.3.0', installerDownloads: 4 },
    { tag: 'v1.2.0', installerDownloads: 3 },
  ])
})

test('empty and unrelated releases produce zero installer downloads', () => {
  assert.deepEqual(summarizeReleases([]), {
    installerDownloads: 0,
    assetDownloads: 0,
    installerAssets: 0,
    releases: [],
  })
  assert.equal(summarizeReleases([release('v0.5.0-sources', [asset('SHA256SUMS.txt', 5)])]).installerDownloads, 0)
})
