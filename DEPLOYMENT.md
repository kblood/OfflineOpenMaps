# OpenMaps v2 Deployment

Web shell publishing pipeline. Modeled on `C:\LLM\IWSDK\DEPLOYMENT.md` —
same SSH key, same GCloud VM, just a different target folder.

## TL;DR

The web shell (`shells/web/`) is 100% client-side after `npm run build`.
**Deploy as cloud-static** — `scp` the `dist/` to the Google Cloud VM at
`dionysus.dk` and serve via Apache from `/var/www/html/openmaps/`.

URL: `https://dionysus.dk/openmaps/`

The Electron shell (`shells/electron/`) doesn't deploy to the cloud at
all — it ships as a Windows portable EXE via `npm run dist:portable -w
@openmaps/electron-shell`.

## One-shot deploy

```bat
release.bat                  :: build + upload
```

Or, if you've already built locally and just want to redeploy:

```bat
release.bat -SkipBuild
```

Both wrap `scripts/release.ps1`, which:

1. Runs `npm run build -w @openmaps/web-shell` (unless `-SkipBuild`).
2. Creates a staging dir on the server:
   `/var/www/html/.staging-openmaps-<rand>/`.
3. `scp`s the contents of `shells/web/dist/` plus `deploy/.htaccess`
   into the staging dir.
4. Atomically rotates the live folder: `mv current → .old`, `mv staging
   → current`, `rm -rf .old`.

Staging + atomic rename means a half-finished upload never leaves a
broken site live, and removed files get cleaned up (unlike a naive
`scp -r` over the existing folder).

## Required: SSH access

The script uses the same SSH key as the IWSDK pipeline:

- Key: `C:\Devstuff\GCloud\caldor_nopass`
- User: `kaspersolesen`
- Host: `35.228.204.127` (a.k.a. `dionysus.dk`)

If `release.ps1` errors with "ssh failed", verify the key is present and
authorized — `ssh -i C:\Devstuff\GCloud\caldor_nopass kaspersolesen@35.228.204.127 whoami`
should print `kaspersolesen`.

## Required: Apache `AllowOverride` on `/openmaps/` (one-time)

By default the `dionysus.dk` vhost has `AllowOverride None` on
`/var/www/`, which makes Apache silently ignore the `.htaccess` shipped
by the release script. Drop a small scoped snippet to enable it just for
this subtree:

`/etc/apache2/conf-available/openmaps.conf`:

```apache
<Directory /var/www/html/openmaps/>
    AllowOverride FileInfo Indexes
</Directory>
```

Enable + reload:

```bash
sudo a2enconf openmaps && sudo systemctl reload apache2
```

Verify:

```bash
curl -sI https://dionysus.dk/openmaps/ | grep -i cache-control
# Expected: Cache-Control: no-cache, must-revalidate
```

Only `FileInfo` + `Indexes` are granted — no `AuthConfig`, no `Limit`,
so a stray `.htaccess` can't loosen access controls.

Reversible: `sudo a2disconf openmaps && sudo systemctl reload apache2`.

## What ships, what doesn't

`deploy/.htaccess` configures:

- Cache-busting headers for `.js / .mjs / .html / .json` so a re-deploy
  takes effect immediately.
- Long max-age for `.woff2 / .ttf / .pbf / .wasm` (Vite-emitted hashed
  filenames are safe to cache aggressively).
- MIME types Apache may not know: `.wasm`, `.pbf` (glyph), `.mbtiles`,
  `.sqlite`.
- COOP/COEP headers are enabled. They are required for `SharedArrayBuffer`,
  which sqlite-wasm's worker-hosted OPFS VFS uses for country-scale packs.
  Keep these headers on HTML, JavaScript, workers, and WASM responses.

`scripts/release.ps1` is `shells/electron/`-aware-but-doesn't-deploy
it. The Electron app is shipped as a Windows portable EXE via a
separate script: `npm run dist:portable -w @openmaps/electron-shell`.

## Iteration loop

1. Edit code under `shells/web/src/`.
2. `npm run dev -w @openmaps/web-shell` for local iteration on
   `http://localhost:5174/`.
3. When ready to publish: `release.bat`.
4. Open `https://dionysus.dk/openmaps/` from any browser.

## Denmark national routing companion

Regional packs overlap for map display, but a cross-region route is calculated
from a separate, merged road graph — it is not assembled by joining independent
route results at an arbitrary pack boundary. The builder preserves OSM node IDs
from the verified regional `geocode.sqlite` files, so roads shared by adjacent
packs become the same vertices in the national graph.

```powershell
node scripts/build-denmark-routing.mjs
npm run build -w @openmaps/platform-node
node scripts/verify-denmark-routing.mjs
```

The default is a 50 km/h-and-above car backbone, which keeps the companion
substantially smaller than the exhaustive graph while retaining a verified
Copenhagen-to-Aarhus route. Use `--min-speed 0` only for an exhaustive local
experiment; it is too large for a practical browser download. Bike and foot
routing remain detailed, regional-pack features. The verifier is a release
gate: it must prove a route across the Zealand/Jutland boundary before the
artifact is published.

The companion is deliberately generated and ignored by Git (`routing/`);
rebuild it from the 28 verified packs rather than committing a binary database.
`scripts/publish-packs.ps1` detects a verified `routing/*.json` descriptor and
uploads its SQLite companion atomically to `/openmaps/packs/routing/` before
publishing the catalogue. The web shell exposes it as an optional, separately
checksum-verified “Denmark-wide car routing” download; it does not duplicate
tiles or search data from regional packs.

When only the regenerated routing companion needs publishing, avoid reuploading
the 28 unchanged map packs:

```powershell
.\scripts\publish-packs.ps1 -SkipPacks
```

## Unified Denmark pack

The regional packs can also be merged into one schema-v2 SQLite database:

```powershell
node scripts/build-denmark-unified.mjs
node scripts/verify-pack.mjs denmark
.\scripts\publish-packs.ps1 -OnlyPack denmark -DryRun
.\scripts\publish-packs.ps1 -OnlyPack denmark
```

The builder writes to a staging directory and only replaces the previous
verified `packs/denmark/` after the database and manifest are complete. The
publisher uses content-addressed remote staging, resumable SFTP transfers,
remote size/SHA-256 verification, bounded SSH commands, and an atomic live
swap. Re-running the same command resumes an interrupted large-file upload.
`-OnlyPack` does not re-upload the separate routing bundle unless
`-PublishRouting` is explicitly included.

The web runtime streams schema-v2 SQLite packs directly into content-addressed
OPFS storage, verifies SHA-256 incrementally, and opens them read-only through
sqlite-wasm's OPFS VFS in a dedicated worker. Interrupted hosted downloads are
resumed with HTTP Range requests. The 5+ GiB unified Denmark pack therefore
does not need a matching multi-gigabyte JavaScript heap allocation. Browsers
without OPFS, workers, `SharedArrayBuffer`, or cross-origin isolation keep the
in-memory regional-pack fallback and reject packs above 1 GiB before download.

## Project-by-project mapping

| Shell | Build cmd | Deploy URL |
|---|---|---|
| `shells/web` | `npm run build -w @openmaps/web-shell` | `https://dionysus.dk/openmaps/` |
| `shells/electron` | `npm run dist:portable -w @openmaps/electron-shell` | local EXE, no URL |

## Known constraints

- **Country packs require modern OPFS support.** The web shell downloads packs
  hosted under `/openmaps/packs/`, checksum-verifies them, stores schema-v2
  files in OPFS, and keeps only the manifest/index in IndexedDB. SQLite access,
  tile reads, search, reverse lookup, parcel lookup, and routing all run in a
  dedicated worker. Small/legacy split packs retain an IndexedDB/in-memory
  fallback for browsers that cannot run the OPFS VFS.
- **CORS for cross-origin pack hosting.** If you ever host packs on a
  different origin than the shell, the pack server must send
  `Access-Control-Allow-Origin`. Same-origin hosting (under
  `/openmaps/packs/`) is the simplest path.
- **HTTPS only.** OPFS and the required isolation features are secure-context
  browser APIs. The cloud server's
  TLS cert is what the browser sees.
