# ARL Online — Claude Code

Activist Resource Library (https://activistresourcelibrary.com): Svelte 5 SPA + Express (`server.js`) + Supabase Postgres + Resend email + Zoom, deployed to Google Cloud Run.

**Start here:**

1. `docs/claude-handoff.md` — current state, open bugs in priority order, pre-launch checklist. Read it at the start of a session.
2. `AGENTS.md` — the canonical project map (architecture, every component, API table, env vars, schema, changelog). It is large; read the sections you need rather than the whole file. Read it before structural changes.

## Rules (shared with Cursor agents)

These two files are the project's agent rules. They are imported so Claude Code follows the same ones:

@.cursor/rules/update-documentation.mdc
@.cursor/rules/expertise-consultations.mdc

In short: after any change to behavior, layout, APIs, scripts, env vars, or structure, update `AGENTS.md` (plus a **Changelog** row) and any affected `docs/automated-*.md`. Don't add new markdown files unless asked. When you fix an item listed under **Expertise consultations → Known issues** in `AGENTS.md`, remove it there and in `docs/claude-handoff.md`.

## Commands

| Task | Command |
|------|---------|
| Local dev (Express :3000 + Vite :5173) | `npm run dev` |
| Build check | `npm run build` |
| Syntax check server | `node --check server.js` |
| Zoom credentials check (network) | `npm run zoom:check` |
| Deploy to Cloud Run | `npm run cloud:build` (reads `.env`; only with the user's go-ahead) |

There is no test suite or linter. Verify with `npm run build`, `node --check`, and by exercising the flow in the browser against `npm run dev`.

## Conventions

- Svelte 5 runes, callback props (not `createEventDispatcher`), global CSS in `src/app.css` only.
- Every user-facing string goes in both `locales/en.json` and `locales/fr.json` (`$t('domain.key')`). Server emails are English-only.
- Public API responses are whitelisted. Never return `userEmail`, `expertEmail`, `timeSlots`, `requestSummary`, `meetingAt`, or Zoom fields from public routes.
- Never put raw `JSON.stringify` inside a `<script>` tag (use `serializeJsonForScript` in `src/lib/seo.js`). CSP has no `'unsafe-inline'` for scripts.
- Per-item locks are in-process: production assumes a **single** Cloud Run instance.
- Schema changes are new numbered files in `supabase/migrations/` (idempotent `IF NOT EXISTS` / drop-then-add constraints). They are applied by hand in the Supabase SQL editor, not by the app.

## Git

- Work lands on `main` at `github.com/samuelaisb/ARL-Online` as direct commits (no PR flow so far). Commit subject is one sentence ending in a period, then a short body.
- Git identity isn't configured globally on this Mac. Commit as `Samuel AisB <samuelaisb@mac.home>` (e.g. `git -c user.name="Samuel AisB" -c user.email="samuelaisb@mac.home" commit ...`) unless the user says otherwise.
- `.env` holds real secrets and is gitignored. Never commit it or print its values.
