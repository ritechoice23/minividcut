# In-app updates

MiniVidCut checks GitHub Releases shortly after launch. When a newer signed
version is published it downloads in the background (Settings → Updates can
turn that off, in which case a small corner card offers **Download**). Nothing
ever blocks the editor: progress shows in the top bar, and when the download
finishes a corner card says the update installs automatically when you close
MiniVidCut. **Restart now** installs immediately with a small passive Windows
installer window. **Not now** snoozes that version until the next release.
Settings → Updates can check manually at any time.

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

Releases are built and uploaded from the maintainer's machine. Never replace files
on a release that is already the latest: a copy of the app that checked just
before the swap holds a signature for the old file and fails until restarted.
Upload everything to a draft first, check it, then publish.

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`, and add the release notes to `CHANGELOG.md`. The
   first three lines of the release notes are what the in-app update card shows.
2. Build with the signing key (see *Building locally*).
3. Check the artifacts:

   ```powershell
   node scripts/verify-update-artifacts.mjs `
     --installer src-tauri/target/release/bundle/nsis/MiniVidCut_X.Y.Z_x64-setup.exe `
     --signature src-tauri/target/release/bundle/nsis/MiniVidCut_X.Y.Z_x64-setup.exe.sig `
     --manifest  src-tauri/target/release/bundle/nsis/latest.json --version X.Y.Z
   ```

   It fails if the installer does not match its signature for the public key in
   `tauri.conf.json`, or if the manifest does not describe that installer.
4. Create the release as a **draft** with the installer, the `.sig` file and
   `latest.json` attached, then publish it. The app reads
   `releases/latest/download/latest.json`, so the published release must be the
   latest one.
5. Download `latest.json` from the published release and compare the installer's
   SHA-256 with the asset digest GitHub shows.

The **Build signed Windows installer** workflow can do steps 2 to 4 in CI, but it
needs the Authenticode certificate secrets and `TAURI_SIGNING_PRIVATE_KEY`; if
either is missing it fails early rather than producing an installer users cannot
update from.

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
Confirm the download dialog appears, that editing stays usable while progress
is shown in the top bar (including after hiding and re-showing the detail
toast), that a **Restart to update** button stays in the top bar once the
download finishes, and that installing waits for the restart prompt. A
development browser session intentionally skips the update check.

The manifest generator can also be run on its own:

```powershell
node scripts/create-update-manifest.mjs --installer <setup.exe> --signature <setup.exe.sig> --version 1.3.0 --out latest.json
```
