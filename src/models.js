export const modelCatalog = {
  fast: {
    label: '快速创作',
    modelName: 'DeepSeek Flash',
    speed: '最快',
    description: '快速整理想法与短文，适合日常灵感。',
    provider: 'openai-compatible',
    defaultModel: 'deepseek-v4-flash',
    credits: 6
  },
  precise: {
    label: '精致排版',
    modelName: 'GPT-5 mini',
    speed: '均衡',
    description: '更细致地组织结构与表达层次。',
    provider: 'openai-compatible',
    defaultModel: 'gpt-5-mini',
    credits: 15
  },
  studio: {
    label: '旗舰创作',
    modelName: 'Claude Sonnet 4',
    speed: '较慢',
    description: '适合复杂内容与更完整的创作方向。',
    provider: 'anthropic-compatible',
    defaultModel: 'claude-sonnet-4',
    credits: 30
  }
};

export function getModel(modelId) {
  return modelCatalog[modelId] ?? null;
}

export const systemPrompt = [
  'You are ZiXian, an exacting visual editor for shareable static documents.',
  'Return valid JSON only. Never return Markdown, links, scripts, commentary, or a full HTML document.',
  'The JSON schema is: {"title": string, "html": string}. html must be a body fragment made only of div, p, h1, h2, h3, span, strong, em, blockquote, ul, ol, li, br, hr, with class attributes only.',
  'Use only these Tailwind-compatible utility classes: min-h-screen w-full max-w-2xl max-w-3xl max-w-4xl mx-auto flex grid block items-center justify-between gap-2 gap-3 gap-4 gap-6 gap-8 space-y-2 space-y-3 space-y-4 space-y-6 space-y-8 space-y-12 p-6 p-8 p-10 p-12 px-6 px-8 py-3 py-6 py-8 py-12 pt-8 pt-16 pb-8 pb-16 mt-2 mt-4 mt-6 mt-8 mt-12 mt-16 mb-2 mb-4 mb-6 mb-8 mb-12 bg-white bg-stone-50 bg-stone-100 bg-stone-900 bg-black text-white text-black text-stone-500 text-stone-600 text-stone-700 text-stone-800 text-stone-900 border border-2 border-black border-stone-200 border-stone-300 border-l-4 border-l-8 rounded rounded-lg rounded-2xl text-xs text-sm text-base text-lg text-xl text-2xl text-3xl text-4xl text-5xl font-normal font-medium font-semibold font-bold font-serif font-sans leading-relaxed leading-tight tracking-wide tracking-widest uppercase italic text-center text-left shadow-sm shadow-lg.',
  'When the creator gives a revision direction, you MUST apply it visibly. Preserve the core idea unless they ask to rewrite it.',
  'Create a fresh safe design palette for the creator. If a style reference is provided, treat it only as inspiration; the output remains the creator’s own design. Do not ignore visual directions.',
  'Build an original static visual composition inside html. Do not use style attributes, ids, images, URLs, forms, SVG, or JavaScript.'
].join(' ');

function conversationMessages(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(message => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .slice(-8)
    .map(message => ({ role: message.role, content: message.content.slice(0, 2400) }));
}

export function createCompositionPrompt({ title, content, instruction, referenceDesign, revision = false }) {
  return [
    `Style reference design (inspiration only): ${referenceDesign ? JSON.stringify(referenceDesign) : 'none; start from a blank canvas'}.`,
    `This is a ${revision ? 'revision of the current document' : 'first draft'}.`,
    `Title: ${title || 'Untitled'}.`,
    `Current document content: ${content}.`,
    `Creator direction: ${instruction || 'Create the strongest first draft.'}`
  ].join('\n');
}

export function parseComposition(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed.title !== 'string' || typeof parsed.html !== 'string' || !parsed.html.trim()) {
    throw new Error('invalid_model_output');
  }
  return {
    title: parsed.title.trim().slice(0, 120),
    html: parsed.html.trim().slice(0, 30000)
  };
}

function providerConfig(model, modelId, env, providerOverrides = {}) {
  const configured = Array.isArray(providerOverrides.accounts)
    ? providerOverrides.accounts.filter(account => account?.enabled !== false && account?.apiKey && account?.baseUrl && account?.tier === modelId)
    : [];
  if (Array.isArray(providerOverrides.accounts)) return { accounts: configured };
  if (model.provider === 'openai-compatible') {
    const deepseek = model.defaultModel.startsWith('deepseek-');
    const override = providerOverrides[deepseek ? 'deepseek' : 'openai'] || {};
    const fallback = {
      key: deepseek ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY,
      url: deepseek ? (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions') : (env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions')
    };
    return {
      accounts: providerAccounts(override, fallback)
    };
  }
  if (model.provider === 'anthropic-compatible') {
    const override = providerOverrides.anthropic || {};
    return { accounts: providerAccounts(override, { key: env.ANTHROPIC_API_KEY, url: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages' }) };
  }
  throw new Error('unsupported_provider');
}

function providerAccounts(override, fallback) {
  const configured = Array.isArray(override.accounts)
    ? override.accounts.filter(account => account?.apiKey && account?.baseUrl)
    : override.apiKey && override.baseUrl ? [{ apiKey: override.apiKey, baseUrl: override.baseUrl }] : [];
  return configured.length ? configured : fallback.key ? [{ apiKey: fallback.key, baseUrl: fallback.url }] : [];
}

function orderedAccounts(accounts, requestKey = '') {
  let hash = 0;
  for (const character of requestKey) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  const start = accounts.length ? hash % accounts.length : 0;
  return accounts.slice(start).concat(accounts.slice(0, start));
}

function shouldFailover(status) {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

function tokenUsage(body, anthropic) {
  const usage = body?.usage || {};
  return anthropic
    ? { inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0 }
    : { inputTokens: Number(usage.prompt_tokens) || 0, outputTokens: Number(usage.completion_tokens) || 0 };
}

export async function generateComposition({ modelId, title, content, instruction, referenceDesign, history, revision = false, env, systemPromptOverride = systemPrompt, providerOverrides, requestKey, fetcher = fetch }) {
  const model = getModel(modelId);
  if (!model) throw new Error('unsupported_model');
  const config = providerConfig(model, modelId, env, providerOverrides);
  if (!config.accounts.length) throw new Error('model_unavailable');
  const prompt = createCompositionPrompt({ title, content, instruction, referenceDesign, revision });
  const messages = [...conversationMessages(history), { role: 'user', content: prompt }];
  const attempts = [];
  let invalidOutput = false;
  for (const account of orderedAccounts(config.accounts, requestKey)) {
    const anthropic = account.apiFormat === 'anthropic' || (!account.apiFormat && model.provider === 'anthropic-compatible');
    const attempt = { accountId: account.id || '', platform: account.platform || 'Worker Secret', modelName: account.modelName || model.defaultModel, httpStatus: null, errorCode: null, inputTokens: 0, outputTokens: 0 };
    const request = anthropic
      ? {
          headers: { 'content-type': 'application/json', 'x-api-key': account.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: account.modelName || model.defaultModel, max_tokens: 1400, system: systemPromptOverride, messages })
        }
      : {
          headers: { 'content-type': 'application/json', authorization: `Bearer ${account.apiKey}` },
          body: JSON.stringify({ model: account.modelName || model.defaultModel, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPromptOverride }, ...messages] })
        };
    try {
      const response = await fetcher(account.baseUrl, { method: 'POST', ...request });
      attempt.httpStatus = response.status;
      if (!response.ok) {
        attempt.errorCode = `http_${response.status}`;
        attempts.push(attempt);
        if (shouldFailover(response.status)) continue;
        throw new Error('model_unavailable');
      }
      const body = await response.json();
      const output = anthropic ? body.content?.[0]?.text : body.choices?.[0]?.message?.content;
      const composition = parseComposition(output);
      Object.assign(attempt, tokenUsage(body, anthropic));
      attempts.push(attempt);
      return { composition, telemetry: { selected: attempt, attempts } };
    } catch (error) {
      if (error.message === 'model_unavailable') throw error;
      if (error.message === 'invalid_model_output') invalidOutput = true;
      attempt.errorCode = error.message === 'invalid_model_output' ? 'invalid_model_output' : 'network_error';
      attempts.push(attempt);
    }
  }
  throw new Error(invalidOutput ? 'invalid_model_output' : 'model_unavailable');
}
