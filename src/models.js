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

export const visualTones = ['original', 'vivid', 'night', 'warm', 'cool'];

export const systemPrompt = [
  'You are ZiXian, an exacting visual editor for shareable static documents.',
  'Return valid JSON only. Never return HTML, CSS, Markdown, links, scripts, or commentary.',
  'The JSON schema is: {"title": string, "paragraphs": string[], "highlight": string, "visualTone": "original"|"vivid"|"night"|"warm"|"cool"}.',
  'When the creator gives a revision direction, you MUST apply it visibly. Preserve the core idea unless they ask to rewrite it.',
  'Map visual directions such as colorful, cyberpunk, neon, vivid, warm, dark, or cool to the closest visualTone. Do not ignore visual directions.',
  'Keep paragraphs to six or fewer and make the highlight distinct from the body.'
].join(' ');

function conversationMessages(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(message => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .slice(-8)
    .map(message => ({ role: message.role, content: message.content.slice(0, 2400) }));
}

export function createCompositionPrompt({ title, content, instruction, style, revision = false }) {
  return [
    `Style identifier: ${style}.`,
    `This is a ${revision ? 'revision of the current document' : 'first draft'}.`,
    `Title: ${title || 'Untitled'}.`,
    `Current document content: ${content}.`,
    `Creator direction: ${instruction || 'Create the strongest first draft.'}`
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
    highlight: parsed.highlight.trim().slice(0, 500),
    visualTone: visualTones.includes(parsed.visualTone) ? parsed.visualTone : 'original'
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

export async function generateComposition({ modelId, title, content, instruction, style, history, revision = false, env, fetcher = fetch }) {
  const model = getModel(modelId);
  if (!model) throw new Error('unsupported_model');
  const config = providerConfig(model, env);
  if (!config.key) throw new Error('model_unavailable');
  const prompt = createCompositionPrompt({ title, content, instruction, style, revision });
  const messages = [...conversationMessages(history), { role: 'user', content: prompt }];
  const request = model.provider === 'anthropic-compatible'
    ? {
        headers: { 'content-type': 'application/json', 'x-api-key': config.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model.defaultModel, max_tokens: 1400, system: systemPrompt, messages })
      }
    : {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
        body: JSON.stringify({ model: model.defaultModel, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, ...messages] })
      };
  const response = await fetcher(config.url, { method: 'POST', ...request });
  if (!response.ok) throw new Error('model_unavailable');
  const body = await response.json();
  const output = model.provider === 'anthropic-compatible' ? body.content?.[0]?.text : body.choices?.[0]?.message?.content;
  return parseComposition(output);
}
