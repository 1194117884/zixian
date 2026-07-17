export const modelCatalog = {
  fast: {
    label: '快速创作',
    provider: 'openai-compatible',
    defaultModel: 'deepseek-v4-flash',
    credits: 6
  },
  precise: {
    label: '精致排版',
    provider: 'openai-compatible',
    defaultModel: 'gpt-5-mini',
    credits: 15
  },
  studio: {
    label: '旗舰创作',
    provider: 'anthropic-compatible',
    defaultModel: 'claude-sonnet-4',
    credits: 30
  }
};

export function getModel(modelId) {
  return modelCatalog[modelId] ?? null;
}

export function createCompositionPrompt({ title, content, instruction, style }) {
  return [
    'You create structured copy for a visual sharing document.',
    'Return JSON only with title, paragraphs (string array, max 6), and highlight.',
    'Do not return HTML, Markdown, links, scripts, or commentary.',
    `Style identifier: ${style}.`,
    `Title: ${title || 'Untitled'}.`,
    `Content: ${content}.`,
    `Creator direction: ${instruction || 'None'}.`
  ].join('\n');
}

export function parseComposition(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.paragraphs) || typeof parsed.highlight !== 'string') {
    throw new Error('invalid_model_output');
  }

  const paragraphs = parsed.paragraphs.filter(paragraph => typeof paragraph === 'string' && paragraph.trim()).slice(0, 6);
  if (!paragraphs.length) throw new Error('invalid_model_output');

  return {
    title: parsed.title.trim().slice(0, 120),
    paragraphs: paragraphs.map(paragraph => paragraph.trim().slice(0, 2000)),
    highlight: parsed.highlight.trim().slice(0, 500)
  };
}

function providerConfig(model, env) {
  if (model.provider === 'openai-compatible') {
    const deepseek = model.defaultModel.startsWith('deepseek-');
    return {
      key: deepseek ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY,
      url: deepseek ? (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions') : (env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions')
    };
  }
  if (model.provider === 'anthropic-compatible') {
    return { key: env.ANTHROPIC_API_KEY, url: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages' };
  }
  throw new Error('unsupported_provider');
}

export async function generateComposition({ modelId, title, content, instruction, style, env, fetcher = fetch }) {
  const model = getModel(modelId);
  if (!model) throw new Error('unsupported_model');
  const config = providerConfig(model, env);
  if (!config.key) throw new Error('model_unavailable');
  const prompt = createCompositionPrompt({ title, content, instruction, style });
  const request = model.provider === 'anthropic-compatible'
    ? {
        headers: { 'content-type': 'application/json', 'x-api-key': config.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model.defaultModel, max_tokens: 1400, messages: [{ role: 'user', content: prompt }] })
      }
    : {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
        body: JSON.stringify({ model: model.defaultModel, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Return valid JSON only.' }, { role: 'user', content: prompt }] })
      };
  const response = await fetcher(config.url, { method: 'POST', ...request });
  if (!response.ok) throw new Error('model_unavailable');
  const body = await response.json();
  const output = model.provider === 'anthropic-compatible' ? body.content?.[0]?.text : body.choices?.[0]?.message?.content;
  return parseComposition(output);
}
