# In-app updates

MiniVidCut checks GitHub Releases shortly after launch. When a newer signed
version is published, an in-app dialog offers **Download update**. The download
runs in the background with a small, hideable progress toast, so editing
continues uninterrupted. When it finishes, a second dialog asks you to
**Restart to update** — **Later** keeps a ready-to-restart toast and the option
in Settings → About. Restarting installs with a small passive Windows installer
window and reopens the new version. Nothing is installed without that final
confirmation. **Not now** snoozes that version until the next release. Settings
→ About → Updates can check manually at any time.

## Why signing is required

Tauri verifies every update with the public key baked into
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Signature checking
cannot be disabled, so an update can only come from someone holding the
matching private key. Update URLs are HTTPS-only in production builds.

## Keys

A keypair has been generated for this project:

- Public key: `~/.tauri/minividcut.key.pub` — already embedded in
  `src-tauri/tauri.conf.json`; safe to share.
- Private key: `~/.tauri/minividcut.key` — **secret**. Keep a secure backup;
  if it is lost, existing installs can no longer be updated.

The private key is not in this repository. To let GitHub Actions sign release
updates, add its **contents** (the whole file, not a path) as a repository
secret named `TAURI_SIGNING_PRIVATE_KEY` under Settings → Secrets and
variables → Actions. The key has no password, so no password secret is needed.

## Publishing an update

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`, and add release notes to `CHANGELOG.md`.
2. Create the GitHub release and tag (for example `v1.3.0`).
3. Run **Build signed Windows installer** with that tag and
   *Replace the installer asset on that release* enabled. The workflow builds
   the Authenticode-signed installer, signs it for the updater, generates
   `latest.json`, and uploads the installer, its `.sig` file and the manifest
   to that release.
4. Make sure the tag is the **latest** release — the app reads
   `releases/latest/download/latest.json`.

If either the Authenticode certificate secrets or the updater key secret are
missing, the workflow fails early with an explicit message rather than
producing an installer that users cannot update from.

## Building locally

`npm run tauri build` needs the private key in the environment (Tauri does not
read `.env` files for this). On PowerShell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME\.tauri\minividcut.key" -Raw
npm run tauri build
```

The signed installer, `.sig` file and a locally generated `latest.json` are
written to `src-tauri/target/release/bundle/nsis/`. `npm run tauri dev` does
not need the key and never checks for updates.

## Testing the flow

To verify the full path, publish a release with a version higher than the
installed app and with `latest.json` attached, then launch the installed app.
Confirm the download dialog appears, that editing stays usable while the
progress toast is shown (including after hiding it), and that installing waits
for the restart prompt. A development browser session intentionally skips the
update check.

The manifest generator can also be run on its own:

```powershell
node scripts/create-update-manifest.mjs --installer <setup.exe> --signature <setup.exe.sig> --version 1.3.0 --out latest.json
```
