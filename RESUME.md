# Stan projektu — pauza 2026-05-12

## PROJECT STATUS: 4.3 COMPLETE (2026-05-16) 🏁

Etap 4.3 (port Hermes self-improvement learning loop) — **ZAMKNIĘTY**.
Wszystkie sub-etapy a/b/c/d/e shipped. Live smoke test zielony na dwóch
providerach. Runbook: `LEARNING_LOOP_SMOKE.md`. Findings: `PORT_PLAN_4_3.md`
sekcja "Discoveries during implementation".

### 4.3.e — wszystkie kroki

| Krok  | Opis                                                                            | Commit        |
| ----- | ------------------------------------------------------------------------------- | ------------- |
| e.1   | live test infrastructure (`skill-review.live.test.ts`)                          | `561bdd7dd8`  |
| e.2   | scenario C (Codex) test                                                         | `e34113b9cf`  |
| e.2.a | auth bridge fix — `SkillReviewContext` dziedziczy `authStorage`+`modelRegistry` | `79fe7cbf56`  |
| e.2.b | diagnostyka (auth profile / accountId / model availability)                     | (bez commitu) |
| e.2.c | provenance merge fix — `composeSkillFile`                                       | `75b44e4d8e`  |
| e.3   | docs — `LEARNING_LOOP_SMOKE.md` runbook + RESUME refresh                        | `563c47ab35`  |
| e.4   | scenario D — DeepSeek smoke test                                                | `6b3f5497fd`  |

### Live smoke results

- **Codex** `gpt-5.4-mini` (OAuth, flat): 12.4s, tokensIn=2364/out=733, skill `repo-file-discovery`
- **DeepSeek** `deepseek-chat` (api_key, ~$0.002): 15.9s, tokensIn=2840/out=926, skill `file-lookup-and-resource-location`
- Oba: SKILL.md z `agent_created: true`, trafna lekcja z transkryptu. Learning loop generalizuje OAuth + api_key.

### Dwa realne bugi złapane przez 4.3.e (niewidoczne dla mock testów)

- **e.2.a auth bridge** — `runSkillReview` zostawiał `authStorage`/`modelRegistry`
  na pi-coding-agent defaults (pusty `agentDir/auth.json`). Prod learning loop
  cicho zwracał `EMPTY_REVIEW_RESULT` przez G7 catch od wpięcia 4.3.c.5.
- **e.2.c provenance merge** — `skill_manage` pisał content modelu verbatim gdy
  zaczynał się od `---`, gubiąc wygenerowany frontmatter w tym `agent_created`.

### POST-PROJECT TODO

- **Security**: zrotuj klucz DeepSeek na platform.deepseek.com (był plaintext w czacie).
- **Cleanup** (po 7-14 dniach): backupy `auth-profiles.json.bak-4.3.e`,
  `auth-state.json.bak-4.3.e`, `models.json.bak-4.3.e-deepseek`.
- **Real machine "All models failed"**: zastosuj profile-cleanup procedure
  z `LEARNING_LOOP_SMOKE.md` §4 do realnego `~/.openclaw/` (provider config
  drift `openai-codex` vs `codex`, heartbeat model).
- **Opcjonalne — upstream PR**: auth bridge (e.2.a) + provenance merge (e.2.c)
  to wartościowe fixy dla OpenClaw upstream.
- **Opcjonalne — Etap 5**: prompt tuning jeśli content quality wymaga poprawy
  po dłuższym użyciu.
- **Tech debt**: `composeSkillFile` YAML quoting naive dla edge cases
  (newline/backslash/specials) — rozważyć YAML serialization library.

---

## Stan pauzy 2026-05-16 (4.3.e — e.3 done, e.4 optional remaining)

**4.3.d ZAMKNIĘTE** (d.4 sandbox config + d.5 auth/model resolution dokończone).
**4.3.e w toku** — live smoke test:

- `561bdd7dd8` e.1 — live test infrastructure (`skill-review.live.test.ts`)
- `e34113b9cf` e.2 — scenario C (Codex) test
- `79fe7cbf56` e.2.a — auth bridge fix (`SkillReviewContext` dziedziczy `authStorage` + `modelRegistry`)
- e.2.b — diagnostyka (bez commitu, feed do e.2.c)
- `75b44e4d8e` e.2.c — provenance merge fix (`composeSkillFile`)
- e.3 — docs: `LEARNING_LOOP_SMOKE.md` (runbook) + ten RESUME refresh

**Live smoke test PRZECHODZI** — learning loop udowodniony end-to-end: real
Codex `gpt-5.4-mini` OAuth → synthetic transcript → review → `skill_manage`
→ `SKILL.md` z `agent_created: true`.

**Pozostało w 4.3.e**: tylko **e.4** — scenariusz DeepSeek (OPCJONALNY,
api_key provider; po nim 4.3.e i całe 4.3 zamknięte).

**Mock suite**: 262 passed | 2 skipped (16 plików). `tsgo tsconfig.core.json` 0 errors.

### Discoveries 4.3.e (6 — szczegóły w commit history + PORT_PLAN_4_3.md)

1. **HOME isolation** — shared test setup izoluje `HOME` do tmpdir; live test
   wymaga `OPENCLAW_LIVE_USE_REAL_HOME=1` by widzieć real auth profiles.
2. **Global OAuth mock** — `test/setup.shared.ts` mockuje `@earendil-works/pi-ai/oauth`
   dla wszystkich testów (zbadane; nie był blockerem).
3. **Auth bridge gap** (`79fe7cbf56`) — `runSkillReview` nie przekazywał
   `authStorage`/`modelRegistry` → pi-coding-agent czytał pusty `auth.json`
   → loop cicho zwracał empty reviews od 4.3.c.5.
4. **accountId profile-specific** — pi-ai `getAccountId` dekoduje OAuth JWT
   po claim `chatgpt_account_id`; codex-cli-synced profil go ma, OpenClaw-native
   login nie.
5. **ChatGPT-account model availability** — Codex OAuth serwuje stały zestaw
   modeli; `gpt-5.1-codex-mini` odrzucony, użyty `gpt-5.4-mini`.
6. **Provenance merge gap** (`75b44e4d8e`) — `skill_manage` odrzucał wygenerowany
   frontmatter gdy model dostarczył własny → `agent_created` gubione.

### Side-effekty środowiska (z e.2.b diagnostyki)

- `~/.openclaw/agents/main/agent/auth-profiles.json` — usunięty broken profil
  `openai-codex:radoslaw.zwolan@onet.pl`; backup `auth-profiles.json.bak-4.3.e`.
- `auth-state.json` — `lastGood["openai-codex"]` → `openai-codex:default`;
  backup `auth-state.json.bak-4.3.e`.

### TODO post-4.3.e

- Real-world "All models failed" — provider config drift `openai-codex` vs
  `codex` + heartbeat model; pełna diagnoza przez `openclaw logs --follow`.
- `composeSkillFile` YAML quoting naive dla edge cases (newline/backslash/specials)
  — rozważyć YAML serialization library.

---

## Stan pauzy 2026-05-15 (mid-4.3.d, after d.3)

**4.3.d w toku — 3 z 5 podkroków zamknięte**:

- `7468f5dd38` d.1 feat: inject createSession seam via SkillReviewDeps
- `c291480b8f` d.2 test: mock fixtures + 3 happy-path tests (empty, create, update)
- `c10c69db9e` d.3 test: 6 guardrail+defensive (G1, G2, G3, empty-name, missing-content, G7) + G5 deferred

**Wyniki po d.3**: **238 passed | 2 skipped** (G5 timeout deferred do 4.3.e, jeden it.skip × 2 workspace projects = 2 skipped). tsgo `tsconfig.core.json` **0 errors**. Drzewo czyste.

**Pozostały scope 4.3.d** (2 podkroki):

- **4.3.d.4** — Sandbox configuration assertions (~50 LOC, 3 tests):
  - `passes noTools: "builtin"` do createAgentSession
  - `passes customTools z dokładnie 1 entry name="skill_manage"`
  - `uses SessionManager.inMemory()` dla review fork
- **4.3.d.5** — Auth + model resolution tests (~80 LOC, 3 tests):
  - Missing API key (G9) — resolveAuth rejects → EMPTY_REVIEW_RESULT
  - Invalid `reviewModel` format (G8) — REVIEW_MODEL_SPEC_REGEX fail → fallback do parent
  - `reviewModel: "auto"` → resolved to parentModel

**Pre-d.4 recon TODO** (przed kodem): `SessionManager.inMemory()` identification — jak rozpoznać instance w test assertion? Opcje:

- `instanceof SessionManager`
- internal marker prop
- Najsłabsza: `expect(opts.sessionManager).toBeDefined()`
  Sprawdź `node_modules/@earendil-works/pi-coding-agent/dist/...` 1 min, wybierz najprostszą strategię.

**G5 timeout — deferred do 4.3.e**:

- Próby: `vi.useFakeTimers + vi.advanceTimersByTimeAsync(61_000)` z pending `session.prompt()` (oba warianty: never-resolve `new Promise(() => {})` ORAZ `setTimeout(resolve, 120_000)`) hangują.
- Root cause: interakcja Promise.race + nested await + microtask drain pod fake timers stalla.
- Workable alternative wymagałaby nowego prod seam (np. `timeoutMs?` w SkillReviewDeps lub injectable setTimeout) — out of scope dla d.3.
- 4.3.e end-to-end z real LLM exercise timeout naturalnie.
- Comment z details inline w `skill-review.test.ts` przy `it.skip`.

**Następny krok po 4.3.d**: **4.3.e** — Smoke test end-to-end z REAL LLM (3 scenariusze: API key Anthropic, OAuth Claude Pro/Max, OAuth Codex; 5 tur prostego zadania każdy; weryfikacja że skille powstają w `~/.openclaw/skills/`). To finalny etap 4.3.

**Plik 4.3.d dotknięte**:

- `src/agents/pi-embedded-runner/skill-review.ts` (d.1 + d.2 — extend `SkillReviewDeps` o `createSession?` + `resolveAuth?`; `runSkillReview` redirect na deps)
- `src/agents/pi-embedded-runner/skill-review.test.ts` (NEW w d.2 + d.3 — 9 helperów + 9 testów + 1 skip)

**Kluczowe decyzje 4.3.d** (do pamiętania przy d.4/d.5):

- Test seam injection przez `SkillReviewDeps` (NIE `vi.mock("@earendil-works/...")` module-level). Konsystencja: createSession (d.1) + resolveAuth (d.2 mini-extend) per-test config, zero shared mock state.
- `captureTools` mechanism w `makeMockSession`: mock `createSession` woła `mock.captureTools(opts.customTools ?? [])` PRZED return — fake session dostaje referencję na stateful `buildReviewToolWithCap` wrapper (G1 closure counter + G3 dedup Set).
- `runAsBackgroundReview` wrap dla testów które wywołują skill_manage (mirror production `learning-review.ts:54`).
- F.5 telemetria via session.messages — assistant variants z `usage: { input, output }`, defensywny cast `(m as { usage? }).usage` znaczy że messages bez `usage` → zero contribution (no crash).
- "Unknown action" test DROPPED — `executeSkillReviewAction` switch nie ma default case (production defensive gap, nie nasz guardrail; testowanie pinowałoby bug).
- G5 timeout DEFERRED do 4.3.e — szczegóły wyżej.

**Push do remote**: branch `fork/hermes-port` — **38 commitów** (etap 4.3 zamknięty, push wykonany).

**TODO Etap 5** (kumulatywne, z 4.3.b, 4.3.c, 4.3.d):

- `auto_retry_start`/`auto_retry_end` events telemetry (z b.5)
- `textOutput` extraction (event listener on `message_end` — z b.5)
- Native `AgentSession.abort()` może zastąpić Promise.race (z b.2)
- Custom `reviewModel` override (`<provider>/<id>` lookup w modelRegistry — z b.3)
- `cost.total` z `Usage` do log line (z b.5)
- File pi-coding-agent issue / contribute corrected types dla `stopReason` runtime/typed mismatch (z c.3.a)
- 9 pre-existing test-file TS errors: `turn-fts-persistence.test.ts` (3) + `skill-manager-tool.test.ts` (6) — cleanup post-4.3.e
- Persist cooldown state w SQLite (`workspace.db`) zamiast in-memory Map (z 4.3.c B.1)
- Configurable cooldown thresholds (3 empties / 10 turns) via `LearningConfig` (z c.3.b)
- G5 timeout hookable seam — `timeoutMs?` w SkillReviewDeps lub injectable setTimeout (z d.3)
- "Unknown action" defensive: add `default` case w `executeSkillReviewAction` switch (z d.3 recon)
- 4.3.c kluczowe decyzje (zarchiwizowane — patrz commit historia dla details):
  - Cooldown gate position B' (counter ticks before cooldown gate)
  - `LearningReviewFn: Promise<ReviewResult | void>` widening
  - `turnCountAtFire` capture in closure (fire-time, not complete-time)
  - `const config = params.config` capture po outer `if (params.config)`
  - Cooldown trip resetuje emptyStreak; active reset clear obu pól (counter zachowuje stan)

Wszystkie pozostałe pre-existing TODO punkty zachowane w sekcjach poniżej.

---

## Gdzie jestem

Etap 4.3 (real reviewFn) — krok **4.3.a UKOŃCZONY i scommitowany**.
Następny krok: **4.3.b (runSkillReview z createAgentSession)**.

Ostatni commit: `e983bcb532 feat(learning): skill_manage tool def for review fork + ReviewResult schema (Step 4.3.a)`
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
- ~~OAuth token refresh retry (1 retry max — przy expired access token)~~ **SKIPPED w pod-kroku b.4** — pi-coding-agent obsługuje natywnie (auto-refresh w `AuthStorage.getApiKey()` + file-level locking + `auto_retry_*` events dla retryable). Zob. PORT_PLAN_4_3.md "Discoveries".
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

**Call site reviewFn (HISTORYCZNE — wpięte w 4.3.c.5):**

- `src/agents/pi-embedded-runner/run/attempt.ts` — `reviewFn` w `scheduleLearningReviewIfDue` woła **real `runSkillReview`** od commita `e9e55a22dd` (4.3.c.5). Od 4.3.e.2.a closure przekazuje też `authStorage` + `modelRegistry`. No-op mock z tej linii już nie istnieje.

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
