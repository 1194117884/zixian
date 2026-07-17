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
