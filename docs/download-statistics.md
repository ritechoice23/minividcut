# Download statistics

The README badge shows the total number of **installer** downloads across all
releases. It is generated from GitHub's own release-asset metrics — no
analytics service, tracking, or personal data is involved.

## How it is measured

GitHub exposes a `download_count` for every release asset through the REST API
(`GET /repos/ritechoice23/minividcut/releases`). Each fetch of an asset through
GitHub increments that counter. `scripts/update-download-stats.mjs` sums the
counts for assets named `MiniVidCut_*_setup.exe` across every release and writes
the result to `docs/download-stats.json`.

Only installer assets are counted on purpose:

- `latest.json` is fetched by the updater on **every app launch**, so including
  it would make the number measure launches rather than downloads.
- `.sig` files and the FFmpeg source archives on `v0.5.0-sources` are not app
  installs either.

The all-assets total is still recorded as `assetDownloads` in the JSON for
comparison. For the current release, the raw asset total is 14 while actual
installer downloads are 9.

## How it is displayed

`docs/download-stats.json` is committed to the repository and refreshed daily
by `.github/workflows/update-download-stats.yml`. The README badge reads
`installerDownloads` from the raw file through Shields' Dynamic JSON badge, so
it updates whenever that workflow commits new data. You can also run the
workflow manually from the Actions tab.

To refresh locally:

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/update-download-stats.mjs
```

## Limitations

- This counts asset download requests, not unique people or successful
  installs. A retry, a download manager, or a CDN cache miss can affect the
  number.
- GitHub's counters can lag and are not a billing-grade analytics source.
- Downloads from mirrors or sources other than this repository's release page
  are invisible here.
- Adding a new asset naming scheme (for example a different installer format)
  requires updating `INSTALLER_NAME` in the script.
