# ARL Online — Claude Code

Activist Resource Library (https://activistresourcelibrary.com): Svelte 5 SPA + Express (`server.js`) + Supabase Postgres + Resend email + Zoom, deployed to Google Cloud Run.

**Start here:**

1. `AGENTS.md` — the project map: the docs table (which doc holds what), the docs rules, architecture, which `src/lib` modules run on the server, where to edit for common changes, npm scripts, the directory layout. Read it first; it's about 55 KB.
2. `docs/claude-handoff.md` — what's in production, open owner steps, open bugs in priority order, pre-launch decisions. Read **Where things stand** and the **Backlog** at the start of a session.
3. The topic doc for what you're changing: `docs/frontend.md`, `docs/backend.md`, `docs/consultations.md`, `docs/automated-*.md`. They're long; search them for the file, function or route instead of reading them whole. `docs/changelog.md` is history only.

## Rules (shared with Cursor agents)

These two files are the project's agent rules. They are imported so Claude Code follows the same ones:

@.cursor/rules/update-documentation.mdc
@.cursor/rules/expertise-consultations.mdc

In short: after any change to behavior, layout, APIs, scripts, env vars, or structure, update the doc that covers it (`AGENTS.md` → **Start here** says which), add a row at the top of the **Change log** in `docs/changelog.md`, and update any affected `docs/automated-*.md`. Open bugs and owner to-dos live only in `docs/claude-handoff.md`; delete an item there once it's fixed. Don't add new markdown files unless asked.

## Commands

| Task | Command |
|------|---------|
| Local dev (Express :3000 + Vite :5173) | `npm run dev` |
| Build check | `npm run build` |
| Syntax check server | `node --check server.js && for f in server/*.js; do node --check "$f"; done` |
| Zoom credentials check (network) | `npm run zoom:check` |
| Deploy to Cloud Run | Push to `main` (deploys automatically, see **Git**). `npm run cloud:build` (reads `.env`) is the manual route, only needed to change Cloud Run env vars or secrets. Both only with the user's go-ahead |

There is no test suite or linter. Verify with `npm run build`, `node --check`, and by exercising the flow in the browser. `npm run dev` uses the production `.env` (see **Git**), so test write flows on the mock backend instead: `.claude/harness/mock/` runs the real `server.js` on an in-memory Supabase with recorded Resend, Zoom and Slack (read its `README.md`). `.claude/` is untracked and exists only on the owner's Mac; `AGENTS.md` → **Start here** lists what's in it.

## Conventions

- Svelte 5 runes, callback props (not `createEventDispatcher`), global CSS in `src/app.css` only.
- Every user-facing string goes in both `locales/en.json` and `locales/fr.json` (`$t('domain.key')`). Server emails are English-only.
- Public API responses are whitelisted. Never return `userEmail`, `expertEmail`, `timeSlots`, `requestSummary`, `meetingAt`, or Zoom fields from public routes.
- Never put raw `JSON.stringify` inside a `<script>` tag (use `serializeJsonForScript` in `src/lib/seo.js`). CSP has no `'unsafe-inline'` for scripts.
- Per-item locks are in-process: production assumes a **single** Cloud Run instance.
- Schema changes are new numbered files in `supabase/migrations/` (idempotent `IF NOT EXISTS` / drop-then-add constraints). They are applied by hand in the Supabase SQL editor, not by the app.

## Git

- Work lands on `main` at `github.com/samuelaisb/ARL-Online` as direct commits (no PR flow so far). Commit subject is one sentence ending in a period, then a short body.
- **A push to `main` deploys production.** A Cloud Build trigger in Google Cloud (not in this repo; `cloudbuild.yaml` is only used by `npm run cloud:build`) builds the image and deploys the `arl-online` Cloud Run service on every push, keeping the service's current env vars and secrets. So push only when the user asks, after `npm run build` and the server syntax checks pass, and make sure any new migration is applied in Supabase before pushing code that needs it. After pushing, confirm the deploy on the live site (for example, a new route behaviour or a string in the live bundle; Cloud Build's asset names differ from a local build's), then update **Where things stand** in `docs/claude-handoff.md` and add an entry at the top of the **Deploy log** in `docs/changelog.md`.
- Git identity isn't configured globally on this Mac. Commit as `Samuel AisB <samuelaisb@mac.home>` (e.g. `git -c user.name="Samuel AisB" -c user.email="samuelaisb@mac.home" commit ...`) unless the user says otherwise.
- `.env` holds real secrets and is gitignored. Never commit it or print its values.
- Local `.env` is the **production** Supabase project plus live Zoom, Resend, and Slack. Don't exercise write flows (requests, scheduling, cancelling, admin edits) in local dev without the user's go-ahead; test them against a mocked Supabase client instead.
