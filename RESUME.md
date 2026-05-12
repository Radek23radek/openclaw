# Stan projektu — pauza 2026-05-12

## Gdzie jestem

Etap 4.3 (real reviewFn) — krok **4.3.a UKOŃCZONY i scommitowany**.
Następny krok: **4.3.b (runSkillReview z createAgentSession)**.

Ostatni commit: `0cf5329607 feat(learning): skill_manage tool def for review fork + ReviewResult schema (Step 4.3.a)`
Branch: `main` (10 commitów ponad `origin/main` — nic nie pushowane)

## Co już zrobione (chronologicznie)

- Etap 1: Analiza obu projektów (`ANALYSIS.md` w `/home/ubuntu/`)
- Etap 2: Plan portu (`PORT_PLAN.md` w `/home/ubuntu/`)
- Etap 3: 5 modułów core, 104 testy
  - Module 1: FTS5 Store (`src/memory/fts-store.ts` + cache)
  - Module 2: `memory_search` tool (`src/tools/memory-search-tool.ts`)
  - Module 3: `skill_manage` tool + provenance (`src/agents/skills/`)
  - Module 4: Learning loop hook (`src/agents/pi-embedded-runner/learning-review.ts`)
  - Module 5: ContextCompressor facade (`src/agents/context-compressor.ts`)
- Krok 4.1: FTS store wpięty do `attempt.ts` (+ amendment: 128KB head/tail truncation dla assistant/tool, user 1:1)
- Krok 4.2: `scheduleLearningReviewIfDue` z interval + natural-break throttling
- Plan 4.3 zatwierdzony (`PORT_PLAN_4_3.md` w root) — **OPCJA A**: dziedziczymy auth z parent przez `getApiKeyForModel` + `createAgentSession`
- Krok 4.3.a: `skill_manage` tool definition (3 akcje, bez `list`) + `ReviewResult` schema (194/194 testów zielone)

## Co dalej — kolejność implementacji

**4.3.b**: `runSkillReview` z `createAgentSession` (full fork z `max_iterations=4`)

- Inherit parent's `authStorage`
- `noTools: "builtin"` + `skill_manage` jako `customTool` (sandbox)
- Pre-flight `getApiKeyForModel`
- Guardrails G1-G10 (max 3 skille/review, dedup, content cap, timeout 60s, model name validation, zero-throw)
- OAuth token refresh retry (1 retry max — przy expired access token)
- Resolve `learning.reviewModel`: `"auto"` (default) → parent's model, lub `"<provider>/<model_id>"`

**4.3.c**: Cooldown state w trigger module (update Step 4.2)

- Callback z review → trigger state (eventually-consistent)
- `Map<sessionKey, {lastReviewAt, consecutiveEmpty}>`
- Skip jeśli 3× empty z rzędu → 10 tur cooldown
- Reset na pierwszy non-empty review

**4.3.d**: Mock LLM strategy + test cases

- 11 oryginalnych z planu (empty, 1 create, 1 update, cap exceeded, malformed, unknown action, throws, duplicate, oversized content, cooldown trip, cooldown reset)
- - sandbox tests (3): bash blocked, read blocked, write do `auth-profiles.json` blocked
- - auth tests (3): expired OAuth → refresh + retry, missing profile → skip + warn, fallback do parent's model przy bad `reviewModel`
- - concurrency limit (2): równoległe wywołania `runSkillReview` w tej samej sesji (FIFO przez lane)

**4.3.e**: Smoke test end-to-end z REAL LLM

- 3 scenariusze: API key Anthropic, OAuth Claude Pro/Max, OAuth Codex (GPT-5/5.3 Codex)
- 5 tur prostego zadania każdy, sprawdź że skille powstają w `~/.openclaw/skills/`
- Sprawdź logi API calls (lub billing dashboard) że auth poszedł tam gdzie miał
- Pomyśleć o cost monitoring — Opus 4.7 ~$1.13/review, Sonnet ~$0.30, OAuth flat

## Kluczowe decyzje do pamiętania

- `learning.reviewModel` default: `"auto"` (dziedziczy parent's model — Anthropic API, OAuth Claude Pro/Max, OAuth Codex wszystko działa za darmo bo flat subscription)
- `max_iterations=4` dla full fork (G1 — twardy cap na liczbę iteracji tool use)
- `noTools: "builtin"` + `skill_manage` jako `customTool` (sandboxing — read/bash/edit/write wyłączone)
- Cooldown G4: w trigger module, eventually-consistent state (callback z review)
- Tool messages w `LearningMessage` z 2KB cap, format: `[tool: name=X duration=Yms exit=Z]\n<truncated output>`
- `reviewModel` format: `"<provider>/<model>"` string w 4.3, object format → Etap 5
- Pre-flight `getApiKeyForModel` przed payload prep — jeśli brak auth → skip + cooldown
- OAuth expired podczas call: refresh przez OpenClaw abstrakcję + retry raz, fail → empty review + cooldown G4
- Telemetria minimum w 4.3: `tokensIn`/`tokensOut` z `response.usage` w logu (pełna telemetria → Etap 5)
- Lock profile share z parentem (TAK) — review identyfikuje się tym samym profilem co parent dla consistency quotas
- `agentDir` share z parentem (TAK) — konieczne dla auth profile access

## Otwarte pytania / TODO na potem

- **Etap 5**: `skill_view` dla update operations (jeśli quality issues — model widzi tylko name+description w pre-injected snapshot, nie pełny content)
- **Etap 5**: object format dla `learning.reviewModel` (per-provider settings, thinking level override)
- **Etap 5**: persistowanie counter state (teraz in-memory, reset na restart procesu)
- **Etap 5**: profile/preferences updates (`_MEMORY_REVIEW_PROMPT` + `_COMBINED_REVIEW_PROMPT` z Hermesa — memory beyond skills)
- **Etap 5**: pełna telemetria (DB w `workspace.db`, `$cost` calc, aggregation, per-agent dashboard)
- **Etap 5**: `learning.authProfile` override (review na innym profilu niż parent — explicit billing split)
- **Etap 5**: `patch` action w `skill_manage` (old_string/new_string z Hermesa) — surgical edits zamiast full rewrite
- **Etap 5**: `write_file`/`remove_file` action — `references/<topic>.md`, `templates/`, `scripts/` support files
- **Etap 5**: rebrand promptu z attribution → adaptacja nomenklatury OpenClaw (teraz prompt jest 1:1 z Hermesa)
- **Onboarding**: dodać sugestię OAuth (Claude Pro/Max lub ChatGPT Plus) gdy user wybiera "Enable learning loop" — nie wymuszać, tylko info o cost savings

## Pliki do przejrzenia po powrocie

**Plan + decyzje:**

- `/home/ubuntu/my-agent/PORT_PLAN_4_3.md` — pełny plan 4.3 z decyzjami auth/throttling/guardrails
- `/home/ubuntu/PORT_PLAN.md` — oryginalny plan Etapu 3 (modules 1-5)
- `/home/ubuntu/ANALYSIS.md` — analiza obu projektów

**Step 4.3.a (świeże, ostatnio dotknięte):**

- `src/agents/pi-embedded-runner/skill-review-types.ts` — `ReviewResult`, `ReviewActionLog`, `EMPTY_REVIEW_RESULT`, `isEmptyReview()`
- `src/agents/pi-embedded-runner/skill-review-tool.ts` — `SkillReviewToolParamsSchema` (TypeBox, flat enum), `executeSkillReviewAction()`, `createSkillReviewTool()`
- `src/agents/pi-embedded-runner/skill-review-tool.test.ts` — 25 testów × 2 projekty = 50 zielone

**Moduły które 4.3.b będzie wołał:**

- `src/agents/pi-embedded-runner/learning-review.ts` — Module 4 (`scheduleLearningReview` z `runAsBackgroundReview`)
- `src/agents/pi-embedded-runner/learning-review-trigger.ts` — Step 4.2 (gating + counter); zostanie zaktualizowany w 4.3.c (cooldown G4)
- `src/agents/skills/skill-manager-tool.ts` — Module 3 (`skillManage` wykonujący file ops)
- `src/agents/skills/skill-provenance.ts` — Module 3 (`runAsBackgroundReview` context)

**Abstrakcje OpenClawa do użycia w 4.3.b:**

- `src/agents/model-auth.ts:932` — `getApiKeyForModel` (pre-flight auth resolution)
- `src/agents/auth-profiles/types.ts` — `AuthProfileCredential` (api_key | token | oauth)
- `@earendil-works/pi-coding-agent` — `createAgentSession`, `SessionManager.inMemory()`, `ToolDefinition`
- `src/agents/pi-tool-definition-adapter.ts:226` — `toToolDefinitions` (wzorzec konwersji `AnyAgentTool` → `ToolDefinition`)

**Call site do podłączenia (mock reviewFn → real):**

- `src/agents/pi-embedded-runner/run/attempt.ts:3804-3806` — obecnie `reviewFn: async () => { /* No-op review until KROK 4.3 wires the real LLM call. */ }`

## Stan testów

**194/194 zielone (14 plików testowych)** — potwierdzone tuż przed pauzą.

Komenda do walidacji po powrocie:

```bash
node /home/ubuntu/my-agent/node_modules/.pnpm/vitest@4.1.6_@types+node@25.7.0_@vitest+coverage-v8@4.1.6_jsdom@29.1.1_vite@8.0.12_@typ_ff6847b2bac21865925bce40e09c2f6b/node_modules/vitest/vitest.mjs run \
  src/memory/fts-store.test.ts \
  src/tools/memory-search-tool.test.ts \
  src/agents/skills/skill-manager-tool.test.ts \
  src/agents/pi-embedded-runner/learning-review.test.ts \
  src/agents/pi-embedded-runner/learning-review-trigger.test.ts \
  src/agents/context-compressor.test.ts \
  src/agents/pi-embedded-runner/turn-fts-persistence.test.ts \
  src/agents/pi-embedded-runner/skill-review-tool.test.ts
```

**Uwaga**: `pnpm test` triggeruje `pnpm install` (full workspace) który zawodzi z powodu `blockExoticSubdeps` / `minimumReleaseAge` / `pnpm approve-builds` — dlatego używamy bezpośredniego wywołania `vitest.mjs` ze ścieżki w `.pnpm/`. Konfiguracja `pnpm-workspace.yaml` była majstrowana w Etapie 3 (`better-sqlite3` allowBuilds, `blockExoticSubdeps: false`, dodanie do `minimumReleaseAgeExclude`) — szczegóły w PORT_PLAN.md i historii commitów.

## Krótki onboarding po powrocie

1. Przeczytaj **PORT_PLAN_4_3.md** całość (sekcja "Auth strategy decision" jest kluczowa) — 5 min
2. Przeczytaj ten plik (RESUME.md) — 2 min
3. Uruchom test suite powyżej — potwierdź 194/194 zielone
4. Zacznij **Step 4.3.b** od szkieletu `src/agents/pi-embedded-runner/skill-review.ts` (runSkillReview)
5. Tworzymy plik z attribution z Hermesa: `src/agents/pi-embedded-runner/prompts/skill-review-prompt.md` (full `_SKILL_REVIEW_PROMPT` z `research/hermes/run_agent.py:3999-4093` — już wkleony w PORT_PLAN_4_3.md sekcja (a))
