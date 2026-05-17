# Learning Loop — Live Smoke Test Runbook

Maintainer/developer runbook for the end-to-end live smoke test of the
self-improvement learning loop (port stage 4.3.e). Audience: anyone running
or debugging the smoke test. This is fork-internal documentation — the
learning loop is not yet a shipped OpenClaw feature.

## 1. Overview

The learning loop runs a background "skill review" after agent turns: a
forked `AgentSession` reads the recent transcript, decides whether a reusable
technique is worth saving, and writes it as a `SKILL.md` via the `skill_manage`
tool. See `PORT_PLAN_4_3.md` for the full design.

The smoke test (`src/agents/pi-embedded-runner/skill-review.live.test.ts`)
exercises that path against a **real LLM**: real provider auth → real model
call → `skill_manage` → a `SKILL.md` on disk with correct provenance. Unit
tests cover the wiring with mocks; the smoke test is the only proof that the
real LLM + real auth + real prompt path works.

## 2. Quick start

```bash
HOME=$HOME OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_USE_REAL_HOME=1 \
  pnpm test:live src/agents/pi-embedded-runner/skill-review.live.test.ts
```

`pnpm test:live` runs `scripts/test-live.mjs`, which invokes Vitest with
`test/vitest/vitest.live.config.ts` (the config that does NOT exclude
`*.live.test.ts`). A normal `pnpm test` run skips this file entirely.

## 3. Environment variables

| Variable                                    | Required       | Default                     | Description                                                                                                                                                   |
| ------------------------------------------- | -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_LIVE_TEST` (or `LIVE`)            | yes            | —                           | Gates the whole `describe` block. Unset → entire file skipped.                                                                                                |
| `OPENCLAW_LIVE_USE_REAL_HOME`               | yes            | —                           | Keeps the real `HOME`. Without it the shared test setup (`test/test-env.ts`) isolates `HOME` to a tmpdir, hiding the real auth profiles under `~/.openclaw/`. |
| `OPENCLAW_LIVE_SKILL_REVIEW_MODEL`          | no             | `openai-codex/gpt-5.4-mini` | Scenario C (Codex) model ref (`<provider>/<model>`).                                                                                                          |
| `DEEPSEEK_API_KEY`                          | for Scenario D | —                           | DeepSeek API key. Presence gates Scenario D. Set via `export`, never committed.                                                                               |
| `OPENCLAW_LIVE_SKILL_REVIEW_DEEPSEEK_MODEL` | no             | `deepseek/deepseek-chat`    | Scenario D model ref.                                                                                                                                         |
| `OPENCLAW_LIVE_TEST_TIMEOUT_MS`             | no             | `120000`                    | Per-test timeout.                                                                                                                                             |
| `OPENCLAW_LIVE_DUMP_SKILL`                  | no             | —                           | When `1`, dumps each generated `SKILL.md` body to stderr (skill-quality comparison across models).                                                            |

Both gate variables (`OPENCLAW_LIVE_TEST` + `OPENCLAW_LIVE_USE_REAL_HOME`) are
mandatory together: `OPENCLAW_LIVE_TEST=1` alone runs the suite but cannot see
the real auth profiles, so the scenario silently skips.

## 4. Scenario C — Codex OAuth (primary)

### Pre-conditions

- The official Codex CLI is installed and logged in. Verify:
  ```bash
  codex login status   # → "Logged in using ChatGPT"
  ```
- OpenClaw has a synced `openai-codex:default` auth profile (synced from the
  Codex CLI by `src/agents/auth-profiles/external-cli-sync.ts`). This profile
  carries an `accountId` field — required (see Troubleshooting).
- `auth-state.json` `lastGood["openai-codex"]` points at a profile that has
  an `accountId`.

### Supported models

ChatGPT-account Codex (OAuth) only serves a fixed model set. Source of truth:
`~/.codex/models_cache.json`. As of writing:

```
gpt-5.4-mini   (default — smallest/fastest)
gpt-5.4
gpt-5.3-codex
gpt-5.2
codex-auto-review
```

`gpt-5.1-codex-mini` and similar are **not** supported for ChatGPT accounts —
the API rejects them (see Troubleshooting).

### Profile cleanup (when a duplicate / broken profile exists)

Multiple OpenClaw logins can leave a duplicate Codex profile that lacks
`accountId` (an OpenClaw-native login, vs. the Codex-CLI-synced `:default`).
To repair, keeping the Codex-CLI-synced profile:

```bash
cd ~/.openclaw/agents/<agentId>/agent
cp auth-profiles.json auth-profiles.json.bak     # back up first
# Remove any openai-codex:* profile that has no accountId field, keeping
# openai-codex:default. Then point lastGood at the surviving profile:
#   auth-state.json  →  lastGood["openai-codex"] = "openai-codex:default"
```

Re-running `codex login` (browser flow, or `codex login --device-auth`
headless) refreshes the Codex CLI credentials that `:default` syncs from.

## 5. Scenario D — DeepSeek (API key)

DeepSeek is an API-key provider, so it sidesteps the OAuth/accountId
constraints of Scenario C. It also exercises the learning loop against a
non-Codex model, confirming the review path generalizes.

### Pre-conditions

- A DeepSeek API key from <https://platform.deepseek.com>.
- A `deepseek` provider entry in `~/.openclaw/agents/<agentId>/agent/models.json`
  (the smoke test resolves the model via `discoverModels` → `registry.find`,
  which reads `models.json`). Add it under `providers`:

  ```json
  "deepseek": {
    "baseUrl": "https://api.deepseek.com",
    "api": "openai-completions",
    "apiKey": "DEEPSEEK_API_KEY",
    "models": [
      {
        "id": "deepseek-chat",
        "name": "DeepSeek Chat",
        "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 131072,
        "maxTokens": 8192
      }
    ]
  }
  ```

  Note `"apiKey": "DEEPSEEK_API_KEY"` — this is the **name of the env var**,
  not the key itself. The key is never written to a file; it is resolved
  from the environment by `getApiKeyForModel`.

- Export the key in your shell (never commit it):

  ```bash
  export DEEPSEEK_API_KEY=<YOUR_DEEPSEEK_KEY>
  ```

### Run

```bash
HOME=$HOME OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_USE_REAL_HOME=1 \
  pnpm test:live src/agents/pi-embedded-runner/skill-review.live.test.ts
```

Scenario D runs when `DEEPSEEK_API_KEY` is set; otherwise it skips. Override
the model with `OPENCLAW_LIVE_SKILL_REVIEW_DEEPSEEK_MODEL`
(default `deepseek/deepseek-chat`).

### Cost

Roughly `$0.001–0.003` per run — per-token (not flat like Codex OAuth).

## 6. Expected output

A passing run (Scenario C, `gpt-5.4-mini`) looks like:

```
[live][skill-review] target=openai-codex/gpt-5.4-mini agentDir=~/.openclaw/agents/main/agent
[live][skill-review] duration=7512ms tokensIn=2323 tokensOut=720
                     skillsCreated=1 skillsUpdated=0 skillsDeleted=0
                     actionsLog=[{ "action": "create", "name": "repo-file-discovery", "result": "created" }]
 ✓ scenario C — OAuth OpenAI Codex (PRIMARY)
```

- Inner review duration: ~7–15s (real LLM call). Outer Vitest test: ~70s
  (worker/setup overhead).
- `tokensIn` / `tokensOut` are non-zero — the LLM was actually called.
- `skillsCreated >= 1` — the review wrote a skill.

The created `SKILL.md` (real sample, abbreviated):

```markdown
---
name: repo-file-discovery
description: "Efficiently locate files in a repository with minimal, targeted searches before escalating to broader scans."
version: 1.0.0
platforms: [linux, macos, windows]
agent_created: true
created_at: "2026-05-16T15:21:35.340Z"
---

# Repo File Discovery

Use this skill when a user asks for a specific file or location in a repo.

## Workflow

1. **Check the exact path/name first** with a cheap existence test (`stat`, `ls`...).
2. **If that fails, broaden minimally** — case/extension variations, narrow glob.
3. **Escalate to recursive search only once** if the narrower checks fail.
4. **If the file still does not exist**, stop and ask the user to confirm the filename.
```

Note `agent_created: true` — the provenance flag that marks the skill as
agent-authored (eligible for auto-curation; user-authored skills are never
auto-deleted).

## 7. Troubleshooting

| Symptom                                                              | Cause                                                                                                                                                      | Fix                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Failed to extract accountId from token`                             | Auth resolved a Codex profile whose OAuth token lacks the `chatgpt_account_id` JWT claim (an OpenClaw-native-login profile, not the Codex-CLI-synced one). | Run the profile cleanup in §4 — keep `openai-codex:default`, drop the profile without `accountId`, point `lastGood` at `:default`. |
| `... model is not supported when using Codex with a ChatGPT account` | The target model is not in the ChatGPT-account Codex model set.                                                                                            | Use a model from `~/.codex/models_cache.json` (§4), e.g. `gpt-5.4-mini`.                                                           |
| `No API key found for openai-codex` (from `session.prompt()`)        | `runSkillReview` did not pass `authStorage` to `createAgentSession`; pi-coding-agent fell back to the empty `agentDir/auth.json`.                          | Fixed in commit `79fe7cbf56` (auth bridge). If it recurs, verify `SkillReviewContext.authStorage` is threaded through.             |
| Test reports `↓ skipped`, never runs                                 | Missing `OPENCLAW_LIVE_TEST=1` or `OPENCLAW_LIVE_USE_REAL_HOME=1`, or no `openai-codex:` profile present.                                                  | Set both env vars; confirm a Codex profile exists in `auth-profiles.json`.                                                         |
| Assertion fail on `agent_created`                                    | `skill_manage` dropped the provenance flag when the model supplied its own frontmatter.                                                                    | Fixed in commit `75b44e4d8e` (provenance merge).                                                                                   |

## 8. Costs & timing

- **Codex OAuth**: `$0` — flat-rate ChatGPT Plus subscription, no per-call cost.
- **DeepSeek** (Scenario D): ~`$0.001–0.003` per run — per-token.
- **Timing**: real LLM call ~7–15s; full Vitest test ~70s (worker + setup
  overhead dominates).

The smoke test is opt-in via env vars and excluded from the default
`pnpm test` run, so it never incurs cost in normal CI.

## 9. Discoveries (port stage 4.3.e)

Six issues surfaced while bringing the smoke test green. Detail in commit
history and `PORT_PLAN_4_3.md`.

1. **HOME isolation** — the shared test setup isolates `HOME` to a tmpdir;
   `OPENCLAW_LIVE_USE_REAL_HOME=1` is required to see real auth profiles.
2. **Global OAuth mock** — `test/setup.shared.ts` mocks
   `@earendil-works/pi-ai/oauth` for all tests (investigated; not the
   blocker, but relevant to live-auth behavior).
3. **Auth bridge gap** — `runSkillReview` left `authStorage`/`modelRegistry`
   to pi-coding-agent defaults, which read an empty `auth.json`; the loop
   silently produced empty reviews. Fixed: commit `79fe7cbf56`.
4. **accountId is profile-specific** — pi-ai's `getAccountId` decodes the
   OAuth JWT for a `chatgpt_account_id` claim; the Codex-CLI-synced profile
   has it, an OpenClaw-native-login profile does not.
5. **ChatGPT-account model availability** — Codex OAuth serves only a fixed
   model set; `gpt-5.1-codex-mini` is rejected.
6. **Provenance merge gap** — `skill_manage` discarded its generated
   frontmatter (including `agent_created`) when the model supplied its own;
   a real LLM always does. Fixed: commit `75b44e4d8e`.

## 10. Limitations / Related

- Scenario C requires a Codex-CLI-synced auth profile **and** a model from
  the ChatGPT-account set — two environment preconditions an automated test
  cannot self-provision.
- Scenario D requires a DeepSeek API key.
- **Related (out of scope here):** a real-world OpenClaw "All models failed"
  error on the same machine appears tied to the `openai-codex` vs `codex`
  provider split and heartbeat model config — a separate environment/config
  issue, not a learning-loop defect. Full diagnosis needs
  `openclaw logs --follow` at failure time.
