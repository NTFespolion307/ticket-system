/* ============================================================================
 * ai-client.js -- the ONLY file that talks to an LLM provider.
 * ============================================================================
 *
 * Everything else (server.js, the frontend) calls getSuggestion() and never
 * needs to know which provider is behind it. To swap providers, add an entry
 * to PROVIDERS below and set AI_PROVIDER -- no route or UI code changes.
 *
 * Environment variables (see README):
 *   AI_PROVIDER   "claude" (default) | "gemini" | "none"
 *   AI_API_KEY    provider API key. ANTHROPIC_API_KEY / GEMINI_API_KEY are
 *                 accepted as fallbacks.
 *   AI_MODEL      optional model override
 *   AI_BASE_URL   optional API base override (a gateway/proxy, or a test double)
 *
 * With no key set the app still works: server.js falls back to ranking real
 * historical fixes on its own, and labels them source:"history". The LLM only
 * ever adds interpretation on top of that.
 * ==========================================================================*/

'use strict';

// Node loads .env natively (>= 20.12). Load it from the folder this file lives
// in, not the current working directory -- otherwise starting the server from
// anywhere else would silently ignore the key. An absent file is fine; the
// variables may equally come from the shell.
try {
  process.loadEnvFile(require('node:path').join(__dirname, '.env'));
} catch { /* no .env file; use the ambient environment */ }

const PROVIDER = (process.env.AI_PROVIDER || 'claude').toLowerCase();
const API_KEY =
  process.env.AI_API_KEY ||
  (PROVIDER === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY) ||
  '';

/** The shape we ask the model for, and validate on the way back. */
const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    topSuggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fix: { type: 'string' },
          matchCount: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['fix', 'matchCount', 'confidence'],
        additionalProperties: false,
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    generalNotes: { type: 'string' },
  },
  required: ['topSuggestions', 'warnings', 'generalNotes'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You help technicians in an electronics repair shop.

You are given a NEW ticket (what the client reported) and a list of SIMILAR
PAST TICKETS from this shop's own history, each with the diagnostic steps the
technician logged and the fix that finally worked.

Rules:
- Prefer this shop's own history over general knowledge. If several past
  tickets were fixed the same way, say so and count them.
- matchCount is how many of the supplied past tickets support that fix. Use 0
  when a suggestion comes from general troubleshooting knowledge rather than
  the supplied history. Never invent a count.
- Put anything that was initially misdiagnosed, or that is dangerous or easy to
  get wrong, in warnings.
- If the history is thin or unrelated, return few or no topSuggestions and put
  general troubleshooting guidance in generalNotes instead.
- Be terse. A technician is reading this while typing; every entry should be a
  short phrase, not a paragraph.`;

/* ---------------------------------------------------------------------------
 * Providers
 * ------------------------------------------------------------------------ */

const PROVIDERS = {
  /** Anthropic Claude, via the Messages API. */
  claude: {
    defaultModel: 'claude-opus-4-8',
    async call(prompt, { model, signal }) {
      const base = process.env.AI_BASE_URL || 'https://api.anthropic.com';
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          // Structured outputs: the response is guaranteed to match the schema,
          // so there is no prose to strip and no JSON.parse guesswork.
          output_config: {
            effort: 'low',           // a tech is typing; latency matters more than depth
            format: { type: 'json_schema', schema: SUGGESTION_SCHEMA },
          },
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        throw new Error(await explainHttpError(res));
      }

      const data = await res.json();
      if (data.stop_reason === 'refusal') throw new Error('The model declined this request.');

      const text = (data.content || []).find((b) => b.type === 'text')?.text;
      if (!text) throw new Error('No text content in the model response.');
      return JSON.parse(text);
    },
  },

  /**
   * Google Gemini, via the Interactions API
   * (POST /v1beta/interactions, key in the x-goog-api-key header).
   * Gemini 2.5 Flash has a free tier, which makes it a good default when you
   * don't want to fund API credits.
   */
  gemini: {
    // A floating "latest" alias on purpose: pinned Gemini versions get closed
    // to new accounts ("no longer available to new users"), which is exactly
    // how gemini-2.5-flash breaks today. Lite because this endpoint fires
    // while a tech types -- measured ~1.7s vs ~9s for full flash.
    defaultModel: 'gemini-flash-lite-latest',
    async call(prompt, { model, signal }) {
      const base = process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com';
      const res = await fetch(`${base}/v1beta/interactions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
        body: JSON.stringify({
          model,
          // The Interactions API takes a single `input`; there is no separate
          // system field, so the instructions ride along in front of the data.
          input: `${SYSTEM_PROMPT}\n\n${prompt}`,
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: geminiSchema(SUGGESTION_SCHEMA),
          },
        }),
      });

      if (!res.ok) throw new Error(await explainHttpError(res));

      const data = await res.json();
      const text = extractGeminiJson(data);
      if (text === null) throw new Error('No JSON content in the Gemini response.');
      return text;
    },
  },

  /** Explicitly disabled -- history-only suggestions. */
  none: {
    defaultModel: '',
    async call() {
      throw new Error('AI_PROVIDER is "none".');
    },
  },
};

/**
 * Gemini's schema dialect is an OpenAPI subset and rejects some JSON Schema
 * keywords, so strip the ones it does not take (Claude requires them).
 */
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

/**
 * Pull the JSON payload out of an Interactions response. The documented path
 * is steps[].content[].text, where an early step can hold the model's internal
 * reasoning -- so scan for the last text that actually parses as JSON rather
 * than trusting a fixed index. Older/alternate response shapes are tolerated.
 */
function extractGeminiJson(data) {
  const texts = [];
  for (const step of data?.steps || []) {
    for (const item of step?.content || []) {
      if (typeof item?.text === 'string') texts.push(item.text);
    }
  }
  for (const cand of data?.candidates || []) {          // classic generateContent shape
    for (const part of cand?.content?.parts || []) {
      if (typeof part?.text === 'string') texts.push(part.text);
    }
  }
  if (typeof data?.output_text === 'string') texts.push(data.output_text);

  for (let i = texts.length - 1; i >= 0; i--) {
    try { return JSON.parse(texts[i]); } catch { /* try the next one back */ }
  }
  return null;
}

/**
 * Turn a provider HTTP error into something a technician can act on.
 * The provider usually says exactly what is wrong ("credit balance is too
 * low", "invalid x-api-key") -- surfacing that beats a generic "unavailable",
 * which sends people hunting through config that was never the problem.
 */
async function explainHttpError(res) {
  let message = '';
  try {
    const body = await res.json();
    message = body?.error?.message || body?.message || '';
  } catch { /* non-JSON body */ }

  // A short, actionable hint for the cases that actually come up.
  const hint =
    /credit balance/i.test(message) ? 'Add API credits at console.anthropic.com → Plans & Billing.'
    : /api key not valid|api_key_invalid|invalid api key/i.test(message)
      ? 'Check AI_API_KEY in the .env file.'
    : /quota|resource[_ ]exhausted/i.test(message) ? 'Provider quota exhausted — try again later.'
    : res.status === 401 ? 'Check AI_API_KEY in the .env file.'
    : res.status === 403 ? 'This API key is not permitted to use that model.'
    : res.status === 404 ? 'Unknown model — check AI_MODEL in the .env file.'
    : res.status === 429 ? 'Rate limited — try again shortly.'
    : res.status >= 500 ? 'The provider is having trouble; try again shortly.'
    : '';

  return [message || `HTTP ${res.status}`, hint].filter(Boolean).join(' ');
}

/* ---------------------------------------------------------------------------
 * Public surface
 * ------------------------------------------------------------------------ */

/** True when a provider and key are configured well enough to attempt a call. */
function isConfigured() {
  return PROVIDER !== 'none' && Boolean(API_KEY) && Boolean(PROVIDERS[PROVIDER]);
}

function describe() {
  return { provider: PROVIDER, configured: isConfigured(), model: modelFor(PROVIDER) };
}

/** Model ids each provider will accept, so one is never sent to the other. */
const MODEL_PREFIX = { claude: 'claude', gemini: 'gemini' };

/**
 * Which model to use for a provider.
 *
 * A model id belongs to exactly one provider, so a generic AI_MODEL left over
 * from a previous provider must not leak across when AI_PROVIDER changes --
 * sending "claude-..." to Gemini fails with a confusing error. Provider-scoped
 * CLAUDE_MODEL / GEMINI_MODEL always win; a mismatched AI_MODEL is ignored
 * loudly rather than silently obeyed.
 */
function modelFor(name) {
  const fallback = PROVIDERS[name] ? PROVIDERS[name].defaultModel : '';
  const scoped = process.env[`${name.toUpperCase()}_MODEL`];
  if (scoped) return scoped;

  const generic = process.env.AI_MODEL;
  if (!generic) return fallback;

  const prefix = MODEL_PREFIX[name];
  if (prefix && !generic.toLowerCase().startsWith(prefix)) {
    console.warn(
      `  Ignoring AI_MODEL="${generic}": not a ${name} model. Using ${fallback}.\n` +
      `  (Set ${name.toUpperCase()}_MODEL to pick a different ${name} model.)`
    );
    return fallback;
  }
  return generic;
}

/**
 * Ask the model to interpret the matched history.
 * @param {{ticket: object, similar: object[]}} payload
 * @returns {Promise<{topSuggestions: object[], warnings: string[], generalNotes: string}>}
 */
async function getSuggestion(payload, { timeoutMs = 20000 } = {}) {
  const provider = PROVIDERS[PROVIDER];
  if (!provider) throw new Error(`Unknown AI_PROVIDER "${PROVIDER}".`);
  if (!isConfigured()) throw new Error('No AI API key configured.');

  // Never let a slow provider hold a request open; the caller falls back.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await provider.call(buildPrompt(payload), {
      model: modelFor(PROVIDER),
      signal: controller.signal,
    });
    return normalise(raw);
  } finally {
    clearTimeout(timer);
  }
}

/** Render the payload as the text the model sees. */
function buildPrompt({ ticket, similar }) {
  const lines = [];
  lines.push('NEW TICKET');
  lines.push(`Title: ${ticket.title || '(none)'}`);
  if (ticket.deviceModel) lines.push(`Device: ${ticket.deviceModel}`);
  lines.push(`Description: ${ticket.description || '(none)'}`);

  lines.push('', `SIMILAR PAST TICKETS (${similar.length})`);
  if (!similar.length) {
    lines.push('(none -- this shop has no matching history yet)');
  } else {
    for (const s of similar) {
      lines.push('', `--- ticket #${s.id} (${s.brand || '?'} ${s.model || ''})`.trim());
      lines.push(`Symptom: ${s.title}`);
      if (s.description) lines.push(`Details: ${s.description}`);
      if (s.steps && s.steps.length) {
        lines.push('Diagnostic steps logged:');
        for (const step of s.steps) lines.push(`  - ${step}`);
      }
      lines.push(`FIX THAT WORKED: ${s.solution_summary || '(not recorded)'}`);
      if (s.solution_category) lines.push(`Category: ${s.solution_category}`);
    }
  }
  return lines.join('\n');
}

/** Defend against a provider returning a near-miss shape. */
function normalise(raw) {
  const out = raw && typeof raw === 'object' ? raw : {};
  const suggestions = Array.isArray(out.topSuggestions) ? out.topSuggestions : [];
  return {
    topSuggestions: suggestions
      .filter((s) => s && typeof s.fix === 'string' && s.fix.trim())
      .slice(0, 6)
      .map((s) => ({
        fix: String(s.fix).trim(),
        matchCount: Number.isFinite(Number(s.matchCount)) ? Number(s.matchCount) : 0,
        confidence: ['high', 'medium', 'low'].includes(s.confidence) ? s.confidence : 'low',
      })),
    warnings: (Array.isArray(out.warnings) ? out.warnings : [])
      .filter((w) => typeof w === 'string' && w.trim())
      .slice(0, 5)
      .map((w) => w.trim()),
    generalNotes: typeof out.generalNotes === 'string' ? out.generalNotes.trim() : '',
  };
}

module.exports = { getSuggestion, isConfigured, describe, SOLUTION_SCHEMA: SUGGESTION_SCHEMA };
