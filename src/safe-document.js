const themes = {
  note: { background: '#f8e96a', foreground: '#312f19', accent: '#fff9a8', label: 'NOTES' },
  board: { background: '#ece1d3', foreground: '#2b2926', accent: '#d95242', label: '观点板书' },
  magazine: { background: '#f5f2eb', foreground: '#1c1b19', accent: '#1c1b19', label: 'JIAN / 04' },
  social: { background: '#c6d9cc', foreground: '#16362b', accent: '#f4ec75', label: 'IDEA CARD' }
};

const toneOverrides = {
  original: {},
  vivid: { background: '#3b146f', foreground: '#fff8ff', accent: '#58f4dc', label: 'VIVID / ZIXIAN' },
  night: { background: '#13162a', foreground: '#eff2ff', accent: '#8c9eff', label: 'NIGHT / ZIXIAN' },
  warm: { background: '#f7d9bc', foreground: '#48251e', accent: '#ef6a4a', label: 'WARM / ZIXIAN' },
  cool: { background: '#cfe5ef', foreground: '#173847', accent: '#247c9d', label: 'COOL / ZIXIAN' }
};

export const supportedStyles = Object.keys(themes);

export function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

export function createSafeDocument({ title, content, style, visualTone = 'original' }) {
  const baseTheme = themes[style];
  if (!baseTheme) throw new Error('unsupported_style');
  const theme = { ...baseTheme, ...(toneOverrides[visualTone] || toneOverrides.original) };

  const paragraphs = content.trim().split(/\n\s*\n/).filter(Boolean);
  const heading = escapeHtml(title.trim() || paragraphs.shift() || '未命名作品');
  const highlight = escapeHtml(paragraphs.pop() || '把真正重要的那一句，留在这里。');
  const body = paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title><style>html,body{margin:0}body{min-height:100vh;background:${theme.background};color:${theme.foreground};font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;padding:9vw;box-sizing:border-box}.label{font-size:11px;letter-spacing:.16em;opacity:.7;border-bottom:1px solid currentColor;padding-bottom:16px}.index{margin-top:64px;font-size:12px;letter-spacing:.08em;opacity:.65}h1{font-family:Georgia,"Songti SC",serif;font-size:clamp(34px,5vw,68px);line-height:1.22;letter-spacing:-.06em;margin:16px 0 34px}.rule{width:46px;height:4px;background:${theme.accent};margin-bottom:35px}p{font-size:18px;line-height:1.9;max-width:680px;margin:0 0 20px}.highlight{margin-top:70px;padding:24px;border-left:6px solid ${theme.accent};background:rgba(255,255,255,.32);font:700 clamp(21px,3vw,32px)/1.5 Georgia,"Songti SC",serif}.footer{margin-top:76px;font-size:10px;letter-spacing:.16em;opacity:.55}</style></head><body><div class="label">${theme.label}</div><div class="index">01 — VISUAL NOTE</div><h1>${heading}</h1><div class="rule"></div>${body}<div class="highlight">${highlight}</div><div class="footer">ZIXIAN / VISUAL EXPRESSION</div></body></html>`;
}
