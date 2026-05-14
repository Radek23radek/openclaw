# PORT_PLAN_4_3.md — Real `reviewFn` implementation

Date: 2026-05-12
Scope: skill-only review (memory/profile out per user constraint — Etap 5)
Source: `research/hermes/run_agent.py` (`_SKILL_REVIEW_PROMPT`, `_spawn_background_review`)

---

## Auth strategy decision (recon wynik)

**Decyzja: OPCJA A — OpenClaw MA czystą, provider-agnostic abstrakcję LLM. Używamy jej.**

### Co znalazłem (krótko)

OpenClaw dziedziczy abstrakcję z `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai` + dokłada własną warstwę auth.

**Warstwy** (od dołu):

1. **`AuthProfileCredential`** — dyskryminowana unia 3 typów w `src/agents/auth-profiles/types.ts`:
   - `ApiKeyCredential` — `{ type: "api_key", provider, key | keyRef, ... }`
   - `TokenCredential` — `{ type: "token", provider, token | tokenRef, expires?, ... }` (statyczny bearer/PAT, nie odświeżany)
   - `OAuthCredential` — `{ type: "oauth", provider, access, refresh, expires, clientId?, oauthRef?, ... }` (z refresh tokenem, automatycznie odświeżany)

   Wszystkie z polem `provider` jako string. Stored w `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.

2. **`getApiKeyForModel({ model, cfg, profileId, agentDir, workspaceDir, ... })`** (`src/agents/model-auth.ts:932`) — RESOLVE-uje credential do runtime API key string niezależnie od typu. Pod spodem `resolveApiKeyForProvider`, który:
   - dla `api_key`: zwraca `key` lub rozwija `keyRef` (env var, keychain, etc.)
   - dla `oauth`: sprawdza expiry, w razie potrzeby refreshuje, woła `provider.oauth.getApiKey(creds)` aby przemapować OAuth tokens na header-friendly bearer
   - dla `token`: zwraca `token`/rozwija `tokenRef`

3. **`prepareProviderRuntimeAuth`** — finalny per-provider prep: może zmienić `baseUrl` (np. dla Vertex), wstawić extra headers, swap OAuth-derived API key na inny.

4. **`Model<Api>`** (z `@earendil-works/pi-ai`) — typed model descriptor z `api: Api` field. `Api` to dyskryminowana unia — w compact.ts widziałem co najmniej:
   `"anthropic" | "openai-completions" | "openai-responses" | "azure-openai-responses" | "openai-codex-responses"`. Plus inne dla google/mistral/deepseek/ollama (w extensions/\*/).

5. **`createAgentSession(options)`** (`@earendil-works/pi-coding-agent`) — JEDNO wejście, akceptuje `Model<any>`, `customTools: ToolDefinition[]`, `sessionManager`, `authStorage`. Pi-coding-agent dispatchuje wewnętrznie na właściwy provider API w oparciu o `model.api`. **Tool use jest zabstrahowany** — model widzi tools przez ujednolicony `ToolDefinition` shape, każdy provider pakuje to do swojego natywnego formatu (Anthropic `tools[]`, OpenAI `tools[]` z innym shape, OpenAI Responses `tools[]` z jeszcze innym shape).

### Lista wspieranych providerów

Z `extensions/` directory (133 plugins). Te z confirmed auth integration:

| Provider id        | API type                      | Auth typy                                          | Status w 4.3                               |
| ------------------ | ----------------------------- | -------------------------------------------------- | ------------------------------------------ |
| `anthropic`        | `anthropic`                   | api_key + OAuth (`anthropic:claude-cli` — Pro/Max) | ✅ wspierane                               |
| `anthropic-vertex` | `anthropic-vertex`            | OAuth Google + project_id                          | ✅ wspierane (jeśli user ma)               |
| `openai`           | `openai-completions`          | api_key                                            | ✅ wspierane                               |
| `openai-codex`     | `openai-codex-responses`      | OAuth (`openai-codex:codex-cli` — GPT-5/5.3 Codex) | ✅ wspierane                               |
| `google`           | (gemini api)                  | api_key                                            | ✅ wspierane (przez abstrakcję)            |
| `deepseek`         | `openai-completions` (compat) | api_key                                            | ✅ wspierane                               |
| `mistral`          | `openai-completions` (compat) | api_key                                            | ✅ wspierane                               |
| `ollama`           | `openai-completions` (compat) | brak (lokalne)                                     | ✅ wspierane (tool use sprawdzić w modelu) |
| `minimax-portal`   | custom                        | OAuth                                              | ⚠️ untested w 4.3                          |

**Praktyczny wynik**: 4.3 review działa dla każdego providera, który już działa dla głównego agenta w OpenClawie. Zero dedicated auth code.

### Wpływ na implementację 4.3

Zmiany vs. mój pierwotny plan (który zakładał direct Anthropic SDK):

**Co usuwamy / zmieniamy:**

- ❌ `LlmCallFn` z signature `{ model, systemPrompt, messages, tools, maxTokens } → { toolUses, ... }` — zbyt anthropic-specific
- ❌ `defaultAnthropicLlmCall` — nie potrzebujemy
- ❌ pytanie #1 z planu (native tool use vs JSON) — nieaktualne, używamy `createAgentSession` z `customTools: [skillManageToolDef]`, pi-coding-agent obsługuje tool use natywnie per provider
- ❌ pytanie #2 (API key resolution) — odpowiedź: `getApiKeyForModel` resolve-uje auto, dziedziczymy `authStorage` z parenta
- ❌ pytanie #6 (single-turn vs full fork) — używając `createAgentSession` mamy "full fork" za darmo, ale **z `max_iterations: 4` cap** (G1 z planu)

**Co dodajemy:**

- `runSkillReview` używa minimal `createAgentSession`:

  ```typescript
  const { session } = await createAgentSession({
    cwd: tmpdir(),                             // throwaway — review nie pisze plików
    agentDir: <parent agentDir>,
    authStorage: <parent authStorage>,          // inherit OAuth tokens, API keys, refresh logic
    model: <resolved reviewModel>,
    customTools: [skillManageToolDef],
    sessionManager: SessionManager.inMemory(),  // review history nie persystuje
    settingsManager: SettingsManager.create(),
    noTools: "builtin",                         // wyłączamy read/bash/edit/write — tylko skill_manage
  });
  ```

- Model resolution path:

  ```typescript
  const reviewModelSpec = config.learning?.reviewModel ?? "auto";
  const parentModelSpec = resolveAgentModelPrimary(config, agentId); // "anthropic/claude-sonnet-4-6"
  const finalModelSpec = reviewModelSpec === "auto" ? parentModelSpec : reviewModelSpec;
  // Parse "anthropic/claude-opus-4-7" → { provider: "anthropic", id: "claude-opus-4-7" }
  // Resolve to Model<Api> via modelRegistry.getModel(provider, id)
  ```

- `learning.reviewModel`:
  - Default: `"auto"` (dziedziczy provider+model z parent agenta) — **zmiana vs. mojego pierwotnego "claude-opus-4-7" defaulta**
  - Override: string `"<provider>/<model_id>"` (np. `"anthropic/claude-opus-4-7"`)
  - Walidacja: jeśli niepoprawny lub model nie istnieje w modelRegistry → warn + fallback do parent's model

### Lista providerów w 4.3 vs Etap 5

| Provider                                    | 4.3                             | Etap 5                        |
| ------------------------------------------- | ------------------------------- | ----------------------------- |
| `anthropic` (API key)                       | ✅                              | —                             |
| `anthropic` (OAuth claude-cli)              | ✅                              | —                             |
| `anthropic-vertex`                          | ✅                              | —                             |
| `openai` (API key)                          | ✅                              | —                             |
| `openai-codex` (OAuth)                      | ✅                              | —                             |
| `google` (Gemini, API key)                  | ✅                              | —                             |
| `deepseek` / `mistral` / inne OpenAI-compat | ✅                              | —                             |
| `ollama` (lokalne, no-auth)                 | ✅ jeśli model wspiera tool use | —                             |
| Lokalne modele bez tool use                 | ❌ (review wymaga tool use)     | TODO: fallback do JSON output |
| `minimax-portal`                            | ⚠️ untested                     | proper test                   |

**Limitacja w 4.3**: model dla review musi wspierać natywne tool use. Sprawdzimy `model.tools` lub similar capability flag przed wywołaniem; jeśli brak → log warn + skip review.

### Sample configs

**Case 1 — Anthropic API key (najbardziej typowy)**

```jsonc
// ~/.openclaw/openclaw.json
{
  "agents": {
    "main": { "model": "anthropic/claude-sonnet-4-6" }
  },
  "learning": {
    "enabled": true,
    "nudgeInterval": 5
    // reviewModel omitted → "auto" → uses parent's claude-sonnet-4-6
  }
}
// ~/.openclaw/agents/main/agent/auth-profiles.json
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "keyRef": { "kind": "env", "name": "ANTHROPIC_API_KEY" }
    }
  }
}
```

**Case 2 — Claude OAuth Pro/Max + Opus override dla review**

```jsonc
{
  "agents": {
    "main": { "model": "anthropic/claude-sonnet-4-6" }
  },
  "learning": {
    "enabled": true,
    "reviewModel": "anthropic/claude-opus-4-7"   // override; share OAuth profile z parentem
  }
}
// auth-profiles.json
{
  "version": 1,
  "profiles": {
    "anthropic:claude-cli": {
      "type": "oauth",
      "provider": "claude-cli",
      "access": "<oauth_access_token>",
      "refresh": "<oauth_refresh_token>",
      "expires": 1746099200000
    }
  }
}
// Review używa tego samego OAuth profile co parent — getApiKeyForModel automatycznie
// refreshuje gdy expires < now. claude-cli provider ma getApiKey() w ProviderConfig.oauth
// który robi konwersję OAuth → bearer header.
```

**Case 3 — OpenAI Codex OAuth (GPT-5.3 Codex)**

```jsonc
{
  "agents": {
    "main": { "model": "openai-codex/gpt-5.3-codex" }
  },
  "learning": {
    "enabled": true,
    "nudgeInterval": 5
    // reviewModel="auto" → uses gpt-5.3-codex via openai-codex provider
  }
}
// auth-profiles.json
{
  "version": 1,
  "profiles": {
    "openai-codex:codex-cli": {
      "type": "oauth",
      "provider": "openai-codex",
      "access": "<codex_oauth_token>",
      "refresh": "<codex_refresh>",
      "expires": 1746099200000,
      "accountId": "...",
      "chatgptPlanType": "team"
    }
  }
}
// Review tool calls pakowane przez pi-ai w shape openai-codex-responses
// (różny od anthropic — function vs tool_use blocks, ale createAgentSession ukrywa to)
```

### Cost implications

Bo `reviewModel="auto"` dziedziczy parent's model, koszt zależy od tego co user już płaci:

- User na Claude Pro/Max OAuth (flat fee) — review **bezkosztowy** (mieści się w subskrypcji)
- User na Anthropic API key + Sonnet — ~$0.30/review zamiast $1.13 (Sonnet ~3× tańszy od Opus)
- User na Codex OAuth (flat) — bezkosztowy
- User na własnym Ollamie — bezkosztowy

**Konsekwencja**: pytanie #3 z planu (Opus vs Haiku default) **odpada** — default jest "to co user już używa". User świadomie wybiera review-specific model w configu jeśli chce.

### Co to zmienia w pytaniach otwartych z planu

| #   | Pytanie                              | Nowa odpowiedź                                                                                 |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | Tool format: native tool use vs JSON | **N/A — `createAgentSession` + `customTools` ukrywa to**                                       |
| 2   | API key resolution                   | **Z parent's `authStorage` — getApiKeyForModel auto**                                          |
| 3   | Default model Opus 4.7 vs Haiku 4.5  | **N/A — default = "auto" (parent's model). User wybiera w configu**                            |
| 4   | Tool messages w LearningMessage      | **Bez zmian** — wciąż TAK z 2KB truncation                                                     |
| 5   | Cooldown G4 — w trigger czy w review | **Bez zmian** — w trigger, eventually-consistent                                               |
| 6   | Single-turn vs full fork             | **Full fork z max_iterations=4 cap** (createAgentSession naturally pętli się tool→result→tool) |
| 7   | Telemetria w 4.3                     | **Bez zmian** — Etap 5                                                                         |

### Pozostałe sub-pytania dot. auth, na które potrzebuję decyzji

1. **Locked profile**: parent agent ma `lockedProfile?: boolean` w `getApiKeyForModel`. Review dziedziczy tę samą lock? Inaczej review może użyć innego (rotowanego) profilu niż parent w tej samej sesji.
   - **Rekomendacja**: TAK, share lock z parentem — review ma identyfikować się tym samym profilem co parent (consistency z perspektywy quotas/cooldowns).

2. **Sandbox dla review**: parent ma `sandbox.workspaceAccess: "rw"|"ro"|"none"`. Review nie pisze do workspace (skill_manage pisze do `~/.openclaw/skills/` przez Module 3), więc sandbox jest irrelevant. **Sprawdzić**: czy `createAgentSession({ noTools: "builtin" })` faktycznie wyłącza file ops? Tak — w dokumentacji "builtin disable read, bash, edit, write".

3. **`agentDir` dla review**: review używa **parent's `agentDir`** żeby dzielić auth profiles. Sprawdzone: `resolveAgentDir(config, agentId)` jest dostępne. OK.

4. **Provider per review override**: czy chcemy w `learning.reviewModel` wspierać tylko `"<provider>/<model>"` string, czy też pełen object `{ provider, model, thinkingLevel?, ... }`? Hermes ma `self.model` (string).
   - **Rekomendacja**: string-only w pierwszej iteracji. Object format → Etap 5.

5. **Brak auth dla review providera**: jeśli `reviewModel` wskazuje providera bez credentiali (np. user skonfigurował `learning.reviewModel: "anthropic/opus-4-7"` ale ma tylko openai-codex auth), co robić?
   - **Rekomendacja**: pre-flight check w `runSkillReview` — wywołać `getApiKeyForModel` raz na start; jeśli throws → log warn `[learning-review] skip: no auth for reviewModel=...` + return zero-result + ustaw cooldown G4 na 10 tur.

---

## (a) Hermes `_SKILL_REVIEW_PROMPT` — 1:1 baseline

Lokalizacja źródła: `research/hermes/run_agent.py:3999-4093` (Hermes Agent, MIT, NousResearch).
Atrybucja: w SKILL_REVIEW_PROMPT.md header comment + LICENSE-hermes (już dodany w repo).

```
Review the conversation above and update the skill library. Be ACTIVE — most
sessions produce at least one skill update, even if small. A pass that does
nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md
and a `references/` directory for session-specific detail. Not a long flat
list of narrow one-session-one-skill entries. This shapes HOW you update,
not WHETHER you update.

Signals to look for (any one of these warrants action):
  • User corrected your style, tone, format, legibility, or verbosity.
    Frustration signals like 'stop doing X', 'this is too verbose',
    'don't format like this', 'why are you explaining', 'just give me the
    answer', 'you always do Y and I hate it', or an explicit 'remember this'
    are FIRST-CLASS skill signals, not just memory signals. Update the
    relevant skill(s) to embed the preference so the next session starts
    already knowing.
  • User corrected your workflow, approach, or sequence of steps. Encode
    the correction as a pitfall or explicit step in the skill that governs
    that class of task.
  • Non-trivial technique, fix, workaround, debugging path, or tool-usage
    pattern emerged that a future session would benefit from. Capture it.
  • A skill that got loaded or consulted this session turned out to be
    wrong, missing a step, or outdated. Patch it NOW.

Preference order — prefer the earliest action that fits, but do pick one
when a signal above fired:
  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the conversation
     for skills the user loaded via /skill-name or you read via skill_view.
     If any of them covers the territory of the new learning, PATCH that
     one first. It is the skill that was in play, so it's the right one
     to extend.
  2. UPDATE AN EXISTING UMBRELLA (via skills_list + skill_view). If no
     loaded skill fits but an existing class-level skill does, patch it.
     Add a subsection, a pitfall, or broaden a trigger.
  3. ADD A SUPPORT FILE under an existing umbrella. Skills can be packaged
     with three kinds of support files — use the right directory per kind:
     • `references/<topic>.md` — session-specific detail (error
       transcripts, reproduction recipes, provider quirks) AND condensed
       knowledge banks: quoted research, API docs, external authoritative
       excerpts, or domain notes you found while working on the problem.
       Write it concise and for the value of the task, not as a full
       mirror of upstream docs.
     • `templates/<name>.<ext>` — starter files meant to be copied and
       modified (boilerplate configs, scaffolding, a known-good example
       the agent can `reproduce with modifications`).
     • `scripts/<name>.<ext>` — statically re-runnable actions the skill
       can invoke directly (verification scripts, fixture generators,
       deterministic probes, anything the agent should run rather than
       hand-type each time).
     Add support files via skill_manage action=write_file with file_path
     starting 'references/', 'templates/', or 'scripts/'. The umbrella's
     SKILL.md should gain a one-line pointer to any new support file so
     future agents know it exists.
  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing skill covers
     the class. The name MUST be at the class level. The name MUST NOT be
     a specific PR number, error string, feature codename, library-alone
     name, or 'fix-X / debug-Y / audit-Z-today' session artifact. If the
     proposed name only makes sense for today's task, it's wrong — fall
     back to (1), (2), or (3).

User-preference embedding (important): when the user expressed a
style/format/workflow preference, the update belongs in the SKILL.md body,
not just in memory. Memory captures 'who the user is and what the current
situation and state of your operations are'; skills capture 'how to do
this class of task for this user'. When they complain about how you
handled a task, the skill that governs that task needs to carry the lesson.

If you notice two existing skills that overlap, note it in your reply —
the background curator handles consolidation at scale.

Do NOT capture (these become persistent self-imposed constraints that
bite you later when the environment changes):
  • Environment-dependent failures: missing binaries, fresh-install
    errors, post-migration path mismatches, 'command not found',
    unconfigured credentials, uninstalled packages. The user can fix
    these — they are not durable rules.
  • Negative claims about tools or features ('browser tools do not work',
    'X tool is broken', 'cannot use Y from execute_code'). These harden
    into refusals the agent cites against itself for months after the
    actual problem was fixed.
  • Session-specific transient errors that resolved before the
    conversation ended. If retrying worked, the lesson is the retry
    pattern, not the original failure.
  • One-off task narratives. A user asking 'summarize today's market' or
    'analyze this PR' is not a class of work that warrants a skill.

If a tool failed because of setup state, capture the FIX (install command,
config step, env var to set) under an existing setup or troubleshooting
skill — never 'this tool does not work' as a standalone constraint.

'Nothing to save.' is a real option but should NOT be the default. If the
session ran smoothly with no corrections and produced no new technique,
just say 'Nothing to save.' and stop. Otherwise, act.
```

**Plik**: zapiszemy w `src/agents/pi-embedded-runner/prompts/skill-review-prompt.md` z header comment `<!-- Portions derived from Hermes Agent (MIT) - NousResearch — see LICENSE-hermes -->`.

---

## (b) Analiza założeń promptu

### 1. Format wiadomości

- **Hermes**: `[{role: "user"|"assistant"|"tool", content: str, ...}]` — standard OpenAI/Anthropic chat schema. Forka dziedziczy pełny `conversation_history`.
- **My (LearningMessage)**: `{role: "user"|"assistant", content: string}` — już zredukowane, bez tool messages.
- **Zgodność**: ✓ kompatybilne. Hermes dodatkowo widzi `tool` role w historii — my filtrujemy je w `learning-review-trigger.ts`. **To różnica.** Decyzja niżej.

### 2. Tools / funkcje, które prompt zakłada

Hermes prompt referuje:

- `skill_manage` z akcjami: **create, edit, patch, delete, write_file, remove_file** (6)
- `skill_view` (czytanie pojedynczego SKILL.md)
- `skills_list` (listing skilli)

Nasz `skill_manage` (Module 3) ma:

- **create, update, delete, list** (4)
- Brak: `patch` (string replace), `write_file` (references/templates/scripts), `remove_file`, `skill_view`

| Hermes action                   | Nasz odpowiednik                | Status       |
| ------------------------------- | ------------------------------- | ------------ |
| `create`                        | `create`                        | ✓            |
| `edit`                          | `update` (full content replace) | ✓ ekwiwalent |
| `patch` (old_string/new_string) | —                               | ❌ brak      |
| `delete`                        | `delete`                        | ✓            |
| `write_file references/X.md`    | —                               | ❌ brak      |
| `remove_file`                   | —                               | ❌ brak      |
| `skill_view`                    | (możemy pre-injectować listę)   | ✓ workaround |
| `skills_list`                   | `list`                          | ✓            |

### 3. Format outputu

Hermes review NIE jest single-shot JSON. To pełny agent fork z `max_iterations=16` i `enabled_toolsets=["memory", "skills"]`. Model wywołuje `skill_manage` jako natywne tool calls (Anthropic tool_use blocks) w pętli, czytając wyniki i decydując o kolejnych krokach. Skończenie: ostatnia odpowiedź assistanta bez tool_use (`'Nothing to save.'` lub finalne podsumowanie).

### 4. Meta-informacje, które prompt dostaje

- Pełna `conversation_history` (parent's messages) jako kontekst
- Sam prompt review jako ostatnia user message
- Provider/model dziedziczone od parenta (`_parent_runtime`)
- Toolset zawężony do skills+memory
- **NIE dostaje**: workspace name, listy istniejących skilli z opisami, daty. Model używa `skills_list` żeby je odkryć podczas iteracji.

### 5. Czy tworzy profile/preferences updates?

TAK, ale przez OSOBNY tool (`memory`). Hermes ma 3 prompty:

- `_SKILL_REVIEW_PROMPT` — tylko skille (the one we port)
- `_MEMORY_REVIEW_PROMPT` — tylko memory/profile
- `_COMBINED_REVIEW_PROMPT` — oba

**Per twoja decyzja: scope 4.3 = tylko skille → bierzemy tylko `_SKILL_REVIEW_PROMPT`.** Memory/profile updates → Etap 5.

---

## (c) Lista różnic i decyzji

| #   | Różnica                                                                                     | Decyzja                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Hermes używa pełnego agent forka z iterative tool use; my mamy single Anthropic call        | **Adaptujemy nasz kod**: użyj Anthropic Messages API z `tools=[skill_manage_tool_def]` w jednym wywołaniu z `max_tokens=4096`. Model może w jednej odpowiedzi wykonać kilka `tool_use` bloków (lub żadnego). To "single-turn tool use", NIE pełna pętla. Wystarczy dla pierwszej iteracji — model dostaje skille pre-injected w prompcie, więc nie potrzebuje iteracji do discovery.      |
| D2  | Hermes ma 6 akcji, my mamy 4                                                                | **Adapt kod (PRIORYTET 2)**: w 4.3 wspieramy tylko `create`/`update`/`delete`. Akcje `patch`, `write_file`, `remove_file` zostają **TODO Etap 5**. Tool def dla LLM eksponuje TYLKO te 3 akcje — model nawet nie zobaczy patch/write_file.                                                                                                                                                |
| D3  | Hermes nie pre-injectuje istniejących skilli — agent je odkrywa przez `skill_view`          | **Adapt kod**: pre-injectujemy `skills_list()` snapshot (name + description, BEZ full content) jako system context. Daje to modelowi wystarczająco informacji do decyzji create-vs-update. Compromise: model zobaczy listę, ale nie pełne treści. Pełny content tylko gdy model wybierze `update` — wtedy LLM musi przewidzieć całość. To akceptujemy w pierwszej iteracji.               |
| D4  | Prompt mentions `skill_view`, `patch`, `write_file references/...` które u nas nie istnieją | **Zostawiamy prompt 1:1 z atrybucją** (per twoja decyzja "Start od promptu Hermesa 1:1"). Model może próbować wywołać nieistniejące tool/action — nasz reviewFn odrzuca z warning logiem. Adaptacja promptu w drugiej iteracji (Etap 5).                                                                                                                                                  |
| D5  | Hermes review widzi `tool` role messages w historii                                         | **Adapt nasze**: w `learning-review-trigger.ts` (Step 4.2) filtrujemy tylko `user`/`assistant`. Dodajemy `tool` role do `LearningMessage` w 4.3, ale TYLKO syntetyczny opis: `{role: "tool", content: "<tool_name>: <truncated result>"}` — żeby nie wybuchło tokenowo. Truncate do 2KB per tool result. **Update Module 4 `learning-review.ts`**: rozszerz `LearningMessage` role union. |
| D6  | Hermes używa parent's model; my chcemy `claude-opus-4-7` jako default                       | **Adapt kod**: `learning.reviewModel?: string`, default `"claude-opus-4-7"`. Confirmed valid identifier w Anthropic SDK (`Model` union w `messages.d.ts:707`, pierwszy entry).                                                                                                                                                                                                            |
| D7  | Hermes review robi własne `_safe_print` z summary do TUI                                    | **Skip** — u nas już mamy logi `[learning-review] complete sessionKey=... durationMs=...` w Step 4.2. Dodamy `skillsCreated/Updated/Deleted` do tego loga.                                                                                                                                                                                                                                |

---

## (d) reviewFn signature + ReviewResult schema

### Signature

```typescript
// src/agents/pi-embedded-runner/skill-review.ts

export type SkillReviewContext = {
  workspaceDir: string; // do skills_list + do passowania do skill_manage
  agentId: string;
  config: OpenClawConfig;
  model: string; // resolved learning.reviewModel ?? "claude-opus-4-7"
  apiKey: string; // resolved from auth-profiles (parent's credentials)
  /** Injectable for tests — produkcyjna implementacja używa Anthropic SDK */
  llmCall?: LlmCallFn;
};

export type LlmCallFn = (params: {
  model: string;
  systemPrompt: string;
  messages: LearningMessage[];
  tools: AnthropicToolDef[];
  maxTokens: number;
}) => Promise<LlmCallResult>;

export type LlmCallResult = {
  toolUses: Array<{
    name: string; // "skill_manage"
    input: Record<string, unknown>; // { action, name, description?, content? }
  }>;
  stopReason: string;
  textOutput: string; // for "Nothing to save." case
};

export type ReviewResult = {
  skillsCreated: number;
  skillsUpdated: number;
  skillsDeleted: number;
  skipped: number; // tool_use bloki które zfail-owały validation
  textOutput: string; // model's free-text reply (logged, not returned to user)
};

export async function runSkillReview(
  messages: LearningMessage[],
  context: SkillReviewContext,
): Promise<ReviewResult>;
```

`runSkillReview` jest tym co `reviewFn` z `LearningReviewFn` typu (Module 4) wewnątrz wywołuje. Wrapping w `attempt.ts`:

```typescript
scheduleLearningReviewIfDue({
  ...,
  reviewFn: async (msgs) => {
    const result = await runSkillReview(msgs, {
      workspaceDir: resolveAgentWorkspaceDir(params.config, sessionAgentId),
      agentId: sessionAgentId,
      config: params.config,
      model: params.config.learning?.reviewModel ?? "claude-opus-4-7",
      apiKey: await resolveApiKeyForReview(params.config, sessionAgentId),
    });
    // result is logged inside scheduleLearningReviewIfDue's complete-line
  },
});
```

### ReviewResult — jak `attempt.ts` to konsumuje?

**Nijak.** Result jest zwracany do `learning-review-trigger.ts`, który loguje:

```
[learning-review] complete sessionKey=<k> durationMs=<ms> created=N updated=M deleted=K skipped=S
```

i to wszystko. `attempt.ts` nigdy nie widzi tego rezultatu — review jest fire-and-forget.

Dla observability w przyszłości można dorzucić `BackgroundReviewCallback` hook (jak Hermes ma), ale to **NIE jest w scope 4.3**.

---

## Guardrails

| #   | Guardrail                                                   | Wartość                                                                                                   | Wdrożone w                                                                                                      |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| G1  | Max skilli per review (suma create+update+delete)           | **3**                                                                                                     | `runSkillReview` — twardy cap, dodatkowe `tool_use` blocks zliczane do `skipped` z warning logiem               |
| G2  | Max długość skill content                                   | **32_768 B** (reuse `MAX_SKILL_CONTENT_BYTES` z Module 3)                                                 | Walidacja w `skill_manage(create/update)` już istnieje — odrzucone trafiają do `skipped`                        |
| G3  | Dedup w jednym review                                       | Per-name — jeśli model wywoła `create("x")` dwa razy w tej samej iteracji, drugi → `skipped`              | `runSkillReview` trzyma `Set<string> processedNames`                                                            |
| G4  | Cooldown gdy 3 review pod rząd zwrócą 0 skilli LUB sfailują | Pomiń kolejne **N=10** turach (per `sessionKey`)                                                          | Stan: `Map<sessionKey, {failOrEmptyStreak: number, skipUntilTurnCount: number}>` w `learning-review-trigger.ts` |
| G5  | Timeout LLM call                                            | **60s**                                                                                                   | `AbortController` w `runSkillReview`                                                                            |
| G6  | Tool definition limit                                       | Tylko `create`/`update`/`delete` (3 akcje, NIE patch/write_file/remove_file)                              | Tool schema definition w `runSkillReview`                                                                       |
| G7  | Failure resilience                                          | Catch wszystko, log warn, zwróć `{skillsCreated:0, ..., textOutput: "review failed"}` — **nigdy throw**   | Zewnętrzny `try/catch` w `runSkillReview`                                                                       |
| G8  | Model name validation                                       | Jeśli `learning.reviewModel` nie matchuje regex `claude-\w+-\d+`, fallback do `claude-opus-4-7` + warning | Walidacja na starcie `runSkillReview`                                                                           |
| G9  | Auth: graceful skip jeśli brak API key                      | Log warn + return zero-result                                                                             | Walidacja `apiKey` na starcie                                                                                   |

**Uwaga do G4**: cooldown jest świadomie aplikowany na sukcesy "no-op" (model returns 'Nothing to save.'). Jeśli sesja 3× pod rząd nie produkuje skilli, prawdopodobnie nie ma czego znaleźć przez kolejne tury — oszczędzamy ~$0.05 × N tokenów. Reset cooldown przy pierwszym non-zero result lub po `skipUntilTurnCount` turach.

---

## Mock LLM strategy (testowanie)

`runSkillReview` przyjmuje opcjonalny `llmCall: LlmCallFn` w `context`. W produkcji jest `undefined` → moduł resolve'uje na własną Anthropic SDK implementację (osobna funkcja `defaultAnthropicLlmCall`). W testach injectujemy:

```typescript
// fixtures dla różnych scenariuszy:
const mockLlmCall_empty: LlmCallFn = async () => ({
  toolUses: [],
  stopReason: "end_turn",
  textOutput: "Nothing to save.",
});

const mockLlmCall_oneCreate: LlmCallFn = async () => ({
  toolUses: [
    {
      name: "skill_manage",
      input: { action: "create", name: "k8s-deploy", description: "...", content: "..." },
    },
  ],
  stopReason: "end_turn",
  textOutput: "",
});

const mockLlmCall_capExceeded: LlmCallFn = async () => ({
  toolUses: Array.from({ length: 10 }, (_, i) => ({
    name: "skill_manage",
    input: { action: "create", name: `skill-${i}`, description: "...", content: "..." },
  })),
  stopReason: "end_turn",
  textOutput: "",
});

const mockLlmCall_malformed: LlmCallFn = async () => ({
  toolUses: [
    {
      name: "skill_manage",
      input: { /* missing action */ name: "broken" },
    },
  ],
  stopReason: "end_turn",
  textOutput: "",
});

const mockLlmCall_unknownAction: LlmCallFn = async () => ({
  toolUses: [
    {
      name: "skill_manage",
      input: { action: "patch", name: "x", old_string: "a", new_string: "b" }, // unsupported
    },
  ],
  stopReason: "end_turn",
  textOutput: "",
});

const mockLlmCall_throws: LlmCallFn = async () => {
  throw new Error("API timeout");
};
```

**Test cases**:

1. Empty review → `{created:0, updated:0, deleted:0, skipped:0}`, no skills written
2. 1 create → `{created:1, ...}`, skill exists na dysku z `agent_created: true`
3. 1 update of existing → `{updated:1, ...}`, content przepisany
4. Cap exceeded (10 calls) → `{created:3, ..., skipped:7}` (G1)
5. Malformed input (missing `action`) → `{skipped:1}` (G7)
6. Unknown action (`patch`) → `{skipped:1}` (G6 efektywnie — tool def nie eksponuje patch, ale defensywnie też w runtime)
7. LLM throws → `{created:0, ...}`, no exception bubbles (G7)
8. Duplicate name in one review → `{created:1, skipped:1}` (G3)
9. Content over 32KB → `{skipped:1}` (G2)
10. Cooldown: 3× empty result → 4. wywołanie skip bez LLM call (G4)
11. Cooldown reset: empty,empty,empty,empty (skipped),empty,empty,empty,empty,empty,empty (10 turn),success → 12. wywołanie wykonuje LLM (G4 reset)

---

## Model: `claude-opus-4-7` — sprawdzenie

**Verified**: `claude-opus-4-7` jest pierwszą wartością w `Model` union type w `@anthropic-ai/sdk@0.91.1/resources/messages/messages.d.ts:707`:

```typescript
export type Model =
  'claude-opus-4-7' |
  'claude-mythos-preview' |
  'claude-opus-4-6' |
  'claude-sonnet-4-6' |
  'claude-haiku-4-5' |
  ...
```

Także w `BetaManagedAgentsModel` (`resources/beta/agents/agents.d.ts:392`).

**Default**: `learning.reviewModel ?? "claude-opus-4-7"`.
**Validation**: pre-flight check w `runSkillReview` — pasujemy do `^claude-(opus|sonnet|haiku)-\d+(-\d+)*$` regex. Niepasujące → warn + fallback do default.

**Token budget**: Opus 4.7 ma 8192 max output tokens (z `internal/constants.ts`). Wnioskuję że to wystarczy na 3 skill JSONy (~2-3K tokens per skill = ~9K worst case, ale my cappujemy do 32KB content = ~8K tokens per skill, więc 1 max-size skill mieści się w jednym call). Dla 3 średnich skilli (~5K tokens każdy) total = 15K → przekracza single response. **Mitigation w G1**: jeśli model próbuje 3 max-size update'y w jednym calliu, response się przytnie — to OK, te które weszły zostaną zaaplikowane, reszta `skipped`.

**Koszt** (dla obserwability): Opus 4.7 to ~$15/1M input + $75/1M output (2026 pricing assumption). Review wywołanie ~~ 50K input + 5K output = $0.75 + $0.38 ≈ **$1.13 per review**. Z nudgeInterval=5 i 100 turach dziennie ≈ 20 review/day × $1.13 = **$22/day per active user**. To NIE jest tanie. Cooldown (G4) i natural-break gating (Step 4.2) to mityguje. **Sugestia: opcja `learning.reviewModel = "claude-haiku-4-5"` jako budget-friendly default**, ale per twoja decyzja zostaje Opus 4.7. To otwarte pytanie do ciebie niżej.

---

## Pliki do utworzenia w 4.3

```
src/agents/pi-embedded-runner/prompts/skill-review-prompt.md    (prompt + attribution)
src/agents/pi-embedded-runner/skill-review.ts                    (runSkillReview)
src/agents/pi-embedded-runner/skill-review.test.ts               (11+ tests via mock LLM)
src/agents/pi-embedded-runner/skill-review-anthropic.ts          (defaultAnthropicLlmCall)
```

## Pliki do modyfikacji

```
src/config/types.openclaw.ts          (LearningConfig.reviewModel?: string)
src/agents/pi-embedded-runner/learning-review-trigger.ts
                                      (wire runSkillReview as reviewFn; cooldown state — G4)
src/agents/pi-embedded-runner/learning-review.ts
                                      (extend LearningMessage role to include "tool")
src/agents/pi-embedded-runner/run/attempt.ts
                                      (replace no-op reviewFn with real call, resolve apiKey)
```

---

## Otwarte pytania (poproszę o decyzję zanim zacznę kod)

1. **Tool format**: czy używamy Anthropic native tool use API (recommended), czy free-form JSON-w-text? Tool use jest ~3× bardziej niezawodne i ma walidację schema.

2. **API key resolution**: skąd review bierze API key? Opcje:
   - (a) Z parent agent's `auth-profiles.json` (Hermes-style dziedziczenie)
   - (b) Z osobnego `learning.apiKeyEnv` / `learning.apiKey` w configu
   - (c) Z dedicated agent profile (e.g. `~/.openclaw/agents/learning-review/agent/auth-profiles.json`)
   - Rekomendacja: (a) — review używa tych samych credentiali co parent (analogicznie do Hermes `_parent_runtime`). Mniej config surface.

3. **Tool messages w LearningMessage**: czy dodajemy syntetyczne `tool` role z truncated content (D5) w pierwszej iteracji 4.3, czy zostawiamy bez nich? Bez nich model traci kontekst "co agent zrobił". Z nimi: +1-5KB per turn w prompcie review.
   - Rekomendacja: TAK z truncation 2KB per tool result. Model bez tego nie wie czemu user był zadowolony/niezadowolony.

4. **Cooldown (G4) na poziomie 4.2 czy 4.3?** Logicznie należy do trigger (4.2), ale stanowo do review (zna `skillsCreated`). Najlepiej: cooldown live w `learning-review-trigger.ts`, ale receive `ReviewResult` z `runSkillReview` żeby się update'ować. Wymaga: trigger czeka na review result (przez Promise) PRZED następną decyzją cooldown — co jest sprzeczne z "fire-and-forget" pattern.
   - Rekomendacja: cooldown **eventually-consistent** — review odpala fire-and-forget i NA KOŃCU update'uje swój licznik failu w shared state (Map). Trigger czyta przed wywołaniem. Brak race bo session lane = FIFO (taki sam argument jak Step 4.1).

5. **Default model — Opus 4.7 vs Haiku 4.5**: review IS drogi (~$1/call). Czy zmieniamy default na Haiku 4.5 z opcją "upgrade" w configu? Per twoja decyzja jest Opus, ale chcę żebyś znał liczby.

6. **Iteration budget**: Hermes używa `max_iterations=16` — pełna pętla z tool results. My robimy single-turn (1 LLM call → tool_uses → execute → END). W pierwszej iteracji 4.3 to wystarczy bo nie mamy `skill_view` ani `skills_list` w tool def (model nie potrzebuje iteracji do dyskorery). Akceptujesz?

7. **Telemetria**: czy chcesz w 4.3 zapisywać metryki (review duration, tokens used, cost estimate) do osobnej tabeli SQLite w workspace.db? Albo do `~/.openclaw/learning-telemetry.jsonl`?
   - Rekomendacja: zostaw na Etap 5 — w 4.3 wystarczą logi.

---

**Pierwszy krok kodowania po twojej akceptacji**: nowy plik `prompts/skill-review-prompt.md` (czysty markdown z attribution header), potem `runSkillReview` szkielet bez LLM impl, potem testy z mockami, potem `defaultAnthropicLlmCall`, potem wiring w `attempt.ts`.

Czekam na decyzje na 7 pytań powyżej.

---

## Discoveries during implementation

### b.4 SKIPPED — pi-coding-agent native OAuth/retry handling

Original plan: implement OAuth refresh retry logic (1 retry max) inside `runSkillReview`.

Discovered during pre-implementation recon (R2):

- `AuthStorage.getApiKey()` auto-refreshes expired OAuth tokens
  (`pi-coding-agent dist/core/auth-storage.d.ts:125-135` — JSDoc priority list
  step 3: _"OAuth token from auth.json (auto-refreshed with locking)"_; private
  `refreshOAuthTokenWithLock` handles the actual refresh).
- File-level locking handles multi-instance safety
  (`auth-storage.d.ts:5` header — _"Uses file locking to prevent race conditions
  when multiple pi instances"_). No need to share an `AuthStorage` instance
  with the parent agent — two instances on the same `auth.json` coordinate
  via fs locks.
- `AgentSession` has internal retry for retryable errors
  (`agent-session.d.ts:477-478` — _"Check if an error is retryable
  (overloaded, rate limit, server errors). Context overflow errors are NOT
  retryable"_) emitted via `auto_retry_start`/`auto_retry_end` events.
- Non-retryable auth errors propagate as exceptions and are caught by the
  G7 outer `try/catch` in `runSkillReview` → `EMPTY_REVIEW_RESULT`.

**Decision**: SKIP b.4. Our planned retry layer would duplicate native
behavior and risk a race between two retry mechanisms (e.g. our retry
recreates the session while pi-coding-agent's retry is mid-attempt).

Updated b.2 R-auth comment to reflect this discovery.

### Type discrepancy: pi-coding-agent runtime vs pi-ai typed enums

Discovered during 4.3.c.1 test-file recon.

pi-ai `types.d.ts:144` defines `AssistantMessage.stopReason` as enum:
`"stop" | "length" | "toolUse" | "error" | "aborted"`

pi-coding-agent emits at runtime: `"end_turn"`, `"tool_use"` (snake_case).

Production code (`learning-review-trigger.ts:65-66`) handles via defensive cast:

```ts
const stopReason = (last as { stopReason?: unknown }).stopReason;
if (stopReason !== "end_turn") return false;
```

Test helpers use `as unknown as AgentMessage` for the same reason — cannot
satisfy strict pi-ai types with realistic pi-coding-agent values without
stubbing all required `AssistantMessage` fields (`api`, `provider`, `model`,
`usage`) on every fixture.

This is not a bug — it's an asymmetry between SDK type definitions and
actual runtime behavior. Casting is the pragmatic mitigation.

**Future Etap 5 cleanup**: file pi-coding-agent issue upstream OR contribute
corrected types.

### Latent crash hazard for undefined `params.config`

Discovered during 4.3.c.5 pre-implementation verification (V2 recon).

`attempt.ts` call site (`:3796`) originally passed `params.config` directly to:

- `persistTurnMessagesToFts` (Step 4.1)
- `scheduleLearningReviewIfDue` (Step 4.2)

Both downstream consumers assumed `config: OpenClawConfig` (non-undefined):

- `isLearningEnabled` in `learning-review-trigger.ts`: `undefined.learning` → TypeError
- `persistTurnMessagesToFts`: `resolveAgentWorkspaceDir(undefined, agentId)` → crash

TypeScript narrowing was masked because `params.config: OpenClawConfig | undefined`
in `RunEmbeddedPiAgentParams` — strict mode flagged this as the two pre-existing
TS errors at `:3792` and `:3799`, but the existing call site passed it without
narrow and accepted the type warnings.

In practice, `params.config` is always defined at turn-end, so the crash never
manifested in production. But the latent hazard remained.

**4.3.c.5 fix**: outer `if (params.config) { const config = params.config; ... }`
narrow + capture defensively eliminates the hazard. No-op in normal flow,
safe skip in the pathological case. Const capture is also necessary because
TS does not narrow property access (`params.config`) across async closure
boundaries — verified empirically: removing the `!` from `params.config!` in
the closure produces TS2322 at the `runSkillReview` call site.

This is the fourth discovery of undocumented or non-obvious behavior in the
pi-coding-agent / pi-ai ecosystem (alongside: `max_iterations` absence in b.2,
`AuthStorage` file-level locking in b.4, `stopReason` runtime/typed enum
mismatch in c.3.a). Pattern: defensive verification before integration
consistently uncovers latent issues — keep doing the recon-before-code step.

### Future telemetry (Etap 5, not 4.3)

Subscribe to `auto_retry_start`/`auto_retry_end` events for resilience
observability — separate from b.5 cost telemetry (`tokensIn`/`tokensOut`).
