# Checkerboxer

**One deployment. One shared Markdown checklist.**

A small, self-hosted place to get things done together. Everyone who opens a deployment sees the same page. There are no accounts, workspaces, or external services to configure.

## What it does

- Click a checkbox or its task text to check something off; undo a recent toggle.
- Add tasks directly from the checklist, without switching to Markdown.
- Write Markdown in an editor with checklist, split, and source views.
- Continue lists with Enter, indent with Tab, and toggle the current task with Ctrl/⌘ + Enter.
- Autosave after a short pause. Changes appear in other connected browsers through server-sent events.
- Track progress and hide completed tasks.
- Recover an unsaved Markdown draft from browser storage after reconnecting or reloading.
- Resolve simultaneous edits explicitly. A stale editor cannot silently overwrite a newer save.
- Browse the last 50 saved revisions. Restore one into a **review draft** and explicitly publish it.
- Download the current Markdown, and copy the shared page URL.
- Turn Markdown headings into board lanes; drag a task's Markdown subtree between lanes.
- Filter by text, `#tag`, `!high` priority, and `@YYYY-MM-DD` due dates.
- Work in focus mode with a 25-, 50-, or 5-minute timer.
- Open the command palette with Ctrl/⌘ + K; use `/` to search, `B` for the board, and `F` for focus outside editable fields.
- Add a launch, hackathon, daily, or team playbook without replacing existing content.
- Earn shared XP and levels from committed completions, with local 30-second combo chains, particle effects, optional sound, and day/night themes. Reduced-motion preferences disable effects by default.

XP is awarded once per normalized task text: 100 XP per task, 150 for `!high`. Undo/rechecking the same text does not award it again. Duplicate text shares a reward identity; editing the text creates a new identity. This is a cooperative motivational feature, not an anti-cheat system or a competitive leaderboard. Completed tasks present before game initialization earn no retroactive XP. Shared XP persists in SQLite; combos, timers, and activity signals are browser-session features.

## Deploy and preview on Zenith

The root `Dockerfile` and `zenith-compose.yml` are configured for Zenith. The app listens on `0.0.0.0:3000`, runs as the unprivileged `node` user, and stores SQLite on the `checkerboxer-data` named volume.

```sh
zenith auth login                 # once; approve in your browser
zenith check --upload-size
zenith up
```

Open the URL returned by `zenith up`. Preview URLs and expiry times are temporary; a preview is not a permanent catalogue deployment. Export anything you want to keep before a preview expires. **Do not assume preview data transfers into a replacement preview.**

```sh
zenith logs --source build
zenith logs --source runtime
zenith down                      # explicitly stop the current preview
```

An account has one active preview. Do not replace a different repository's preview without deciding to do so explicitly.

### Catalogue publication

Source: https://github.com/l1mey112/checkerboxer. `listing.json` contains the catalogue metadata. The project remains `UNLICENSED`; no open-source license grant is implied. Publishing requires one-time Developer Agreement acceptance for this repository in Zenith's browser flow.

Follow `.agents/skills/zenith-publish/SKILL.md`: commit and push the source, Dockerfile, and Compose file; provide real listing metadata and a screenshot of the running app; submit the full commit SHA. GitHub connection and the Developer Agreement are handled through Zenith. No credentials belong in this repository.

## Sharing and privacy

**Anyone who can reach the deployment can read, edit, and view its retained history.** The link is not a password. This is intentionally a shared, public-by-reachability notebook, not a private notes app. Put an authenticated gateway in front of it if you need restricted access.

- Do not put passwords, personal information, or confidential notes in the page. Deleting text does not immediately remove it from version history or browser draft backups.
- Raw HTML is escaped. Unsafe link protocols are rejected by the Markdown parser. Remote Markdown images are shown as text rather than fetched from third-party servers.
- Scripts, styles, and fonts are served locally; no analytics or third-party CDN is required.
- A restrictive CSP, no CORS allowance, cross-site write checks, request size limits, and a basic write throttle reduce accidental/drive-by misuse. **These are not authentication or comprehensive abuse protection.** A determined visitor with the URL can still edit the page.
- Search engines are asked not to index the page. This is not an access control.

## Storage and operation

Node.js **22.16 or newer** is required (`node:sqlite`). No separate database server is needed. Run a single application instance with its own volume per deployment; live-event fanout is in-process, not a multi-replica service.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listener |
| `DATA_DIR` | `./data` | Directory containing `checkerboxer.sqlite` and WAL files |
| `PUBLIC_ORIGIN` | request host | Optional canonical public origin for browser-origin host checks behind a proxy |

The server uses SQLite WAL mode and transactional, revision-checked writes. Empty pages are supported. The maximum Markdown document size is 256 KiB; up to 50 revisions are retained. Checkbox changes count as revisions. The built-in throttle permits 240 write requests per minute per directly connected address; a reverse proxy can make multiple visitors share that allowance. There is a cap of 200 simultaneous live streams. Presence counts browser connections, not unique people.

`GET /healthz` checks that the process and database respond. Compose and Docker include health checks. Never mount the data volume read-only or delete it if you want to preserve the page. Back up using SQLite's backup API or stop the service before copying the database **and its WAL files**; copying only the live `.sqlite` file can miss committed writes.

The browser stores one recovery draft per origin. It's a convenience, not a backup system or a multi-tab document database. Conflict comparison allows manual reconciliation rather than claiming character-by-character collaborative editing.

## Development checks

```sh
npm ci
npm run check
npm audit --omit=dev
zenith check --upload-size
```

The test suite uses isolated temporary databases and ephemeral test listeners, not a persistent local preview. It covers persistence across restart, conflicting writes, task parsing and toggling, API validation, retained history, live events, static-file isolation, HTML safety, the actual checkbox renderer, and browser save/recovery state transitions.

For development only, `npm run dev` starts Node's file watcher. Production is `npm start`. No build step is needed.

## Project layout

- `server.js`: HTTP API, SQLite persistence, history, live-event stream, and security headers.
- `public/index.html`, `public/styles.css`, `public/app.js`: responsive UI, editor, and synchronization state.
- `public/power.js`, `public/power.css`: board, focus timer, command palette, filters, playbooks, themes, and completion effects.
- `public/tasks.js`: task-source mapping shared by client and server.
- `test/`: Node's built-in test runner; no extra test framework.
- `Dockerfile`, `zenith-compose.yml`: the deployable, single-service stack.

See `PREVIEW.md` for the recorded hosted verification and deployment state. This project is currently `UNLICENSED`; choose a license before public distribution.
