const blankDesign = { background: '#fffefb', foreground: '#1d1d1b', accent: '#1d1d1b', label: 'ZIXIAN / DRAFT' };
const color = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
const allowedTags = new Set(['div', 'p', 'h1', 'h2', 'h3', 'span', 'strong', 'em', 'blockquote', 'ul', 'ol', 'li', 'br', 'hr']);
const voidTags = new Set(['br', 'hr']);
const documentTags = new Set(['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'p', 'h1', 'h2', 'h3', 'h4', 'span', 'strong', 'b', 'em', 'i', 'small', 'mark', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const allowedClasses = new Set([
  'min-h-screen', 'w-full', 'max-w-2xl', 'max-w-3xl', 'max-w-4xl', 'mx-auto', 'flex', 'grid', 'block', 'items-center', 'justify-between',
  'gap-2', 'gap-3', 'gap-4', 'gap-6', 'gap-8', 'space-y-2', 'space-y-3', 'space-y-4', 'space-y-6', 'space-y-8', 'space-y-12',
  'p-6', 'p-8', 'p-10', 'p-12', 'px-6', 'px-8', 'py-3', 'py-6', 'py-8', 'py-12', 'pt-8', 'pt-16', 'pb-8', 'pb-16',
  'mt-2', 'mt-4', 'mt-6', 'mt-8', 'mt-12', 'mt-16', 'mb-2', 'mb-4', 'mb-6', 'mb-8', 'mb-12',
  'bg-white', 'bg-stone-50', 'bg-stone-100', 'bg-stone-900', 'bg-black', 'text-white', 'text-black', 'text-stone-500', 'text-stone-600', 'text-stone-700', 'text-stone-800', 'text-stone-900',
  'border', 'border-2', 'border-black', 'border-stone-200', 'border-stone-300', 'border-l-4', 'border-l-8', 'rounded', 'rounded-lg', 'rounded-2xl',
  'text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl', 'text-4xl', 'text-5xl', 'font-normal', 'font-medium', 'font-semibold', 'font-bold',
  'font-serif', 'font-sans', 'leading-relaxed', 'leading-tight', 'tracking-wide', 'tracking-widest', 'uppercase', 'italic', 'text-center', 'text-left', 'shadow-sm', 'shadow-lg'
]);

export function normalizeDesign(value) {
  return {
    background: color(value?.background) || blankDesign.background,
    foreground: color(value?.foreground) || blankDesign.foreground,
    accent: color(value?.accent) || blankDesign.accent,
    label: typeof value?.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 48) : blankDesign.label
  };
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function safeClasses(raw) {
  return raw.split(/\s+/).filter(token => allowedClasses.has(token)).join(' ');
}

export function sanitizeHtmlFragment(value) {
  const source = typeof value === 'string' ? value.slice(0, 30000) : '';
  const tokens = source.match(/<[^>]*>|[^<]+/g) || [];
  const stack = [];
  let output = '';

  for (const token of tokens) {
    if (!token.startsWith('<')) { output += escapeHtml(token); continue; }
    const closing = token.match(/^<\/\s*([a-z0-9]+)\s*>$/i);
    if (closing) {
      const tag = closing[1].toLowerCase();
      if (stack[stack.length - 1] === tag) { stack.pop(); output += `</${tag}>`; }
      continue;
    }
    const opening = token.match(/^<\s*([a-z0-9]+)([\s\S]*?)\/?\s*>$/i);
    if (!opening) continue;
    const tag = opening[1].toLowerCase();
    if (!allowedTags.has(tag)) continue;
    const classMatch = opening[2].match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    const classes = classMatch ? safeClasses(classMatch[2]) : '';
    output += `<${tag}${classes ? ` class="${classes}"` : ''}>`;
    if (!voidTags.has(tag)) stack.push(tag);
  }
  while (stack.length) output += `</${stack.pop()}>`;
  return output;
}

export function fragmentText(value) {
  return sanitizeHtmlFragment(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 10000);
}

function sanitizeCss(value) {
  return String(value)
    .replace(/@import[\s\S]*?;/gi, '')
    .replace(/@font-face\s*\{[\s\S]*?\}/gi, '')
    .replace(/url\s*\([^)]*\)/gi, '')
    .replace(/(?:expression\s*\(|behavior\s*:|-moz-binding\s*:)/gi, '')
    .slice(0, 30000);
}

function safeDocumentAttributes(raw) {
  const attributes = [];
  for (const match of raw.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    const name = match[1].toLowerCase();
    const value = match[3];
    if (name === 'class' || name === 'id' || name === 'role' || name === 'title' || name === 'lang' || name.startsWith('aria-') || name.startsWith('data-')) attributes.push(`${name}="${escapeHtml(value.slice(0, 240))}"`);
    if (name === 'style') attributes.push(`style="${escapeHtml(sanitizeCss(value).slice(0, 4000))}"`);
  }
  return attributes.length ? ` ${attributes.join(' ')}` : '';
}

export function sanitizeHtmlDocument(value) {
  const source = typeof value === 'string' ? value.slice(0, 120000) : '';
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(match => sanitizeCss(match[1])).filter(Boolean).join('\n');
  const body = (source.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] || source)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|option|link|base|meta|svg|math|audio|video)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|form|input|button|textarea|select|option|link|base|meta|svg|math|audio|video)\b[^>]*\/?\s*>/gi, '');
  const stack = [];
  let output = '';
  for (const token of body.match(/<[^>]*>|[^<]+/g) || []) {
    if (!token.startsWith('<')) { output += escapeHtml(token); continue; }
    const closing = token.match(/^<\/\s*([a-z0-9]+)\s*>$/i);
    if (closing) {
      const tag = closing[1].toLowerCase();
      if (stack[stack.length - 1] === tag) { stack.pop(); output += `</${tag}>`; }
      continue;
    }
    const opening = token.match(/^<\s*([a-z0-9]+)([\s\S]*?)\/?\s*>$/i);
    if (!opening) continue;
    const tag = opening[1].toLowerCase();
    if (!documentTags.has(tag)) continue;
    output += `<${tag}${safeDocumentAttributes(opening[2])}>`;
    if (!voidTags.has(tag)) stack.push(tag);
  }
  while (stack.length) output += `</${stack.pop()}>`;
  return { body: output.trim(), css: styles };
}

const utilityCss = `*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif}.min-h-screen{min-height:100vh}.w-full{width:100%}.max-w-2xl{max-width:42rem}.max-w-3xl{max-width:48rem}.max-w-4xl{max-width:56rem}.mx-auto{margin-left:auto;margin-right:auto}.flex{display:flex}.grid{display:grid}.block{display:block}.items-center{align-items:center}.justify-between{justify-content:space-between}.gap-2{gap:.5rem}.gap-3{gap:.75rem}.gap-4{gap:1rem}.gap-6{gap:1.5rem}.gap-8{gap:2rem}.space-y-2>*+*{margin-top:.5rem}.space-y-3>*+*{margin-top:.75rem}.space-y-4>*+*{margin-top:1rem}.space-y-6>*+*{margin-top:1.5rem}.space-y-8>*+*{margin-top:2rem}.space-y-12>*+*{margin-top:3rem}.p-6{padding:1.5rem}.p-8{padding:2rem}.p-10{padding:2.5rem}.p-12{padding:3rem}.px-6{padding-left:1.5rem;padding-right:1.5rem}.px-8{padding-left:2rem;padding-right:2rem}.py-3{padding-top:.75rem;padding-bottom:.75rem}.py-6{padding-top:1.5rem;padding-bottom:1.5rem}.py-8{padding-top:2rem;padding-bottom:2rem}.py-12{padding-top:3rem;padding-bottom:3rem}.pt-8{padding-top:2rem}.pt-16{padding-top:4rem}.pb-8{padding-bottom:2rem}.pb-16{padding-bottom:4rem}.mt-2{margin-top:.5rem}.mt-4{margin-top:1rem}.mt-6{margin-top:1.5rem}.mt-8{margin-top:2rem}.mt-12{margin-top:3rem}.mt-16{margin-top:4rem}.mb-2{margin-bottom:.5rem}.mb-4{margin-bottom:1rem}.mb-6{margin-bottom:1.5rem}.mb-8{margin-bottom:2rem}.mb-12{margin-bottom:3rem}.bg-white{background:#fff}.bg-stone-50{background:#fafaf9}.bg-stone-100{background:#f5f5f4}.bg-stone-900{background:#1c1917}.bg-black{background:#000}.text-white{color:#fff}.text-black{color:#000}.text-stone-500{color:#78716c}.text-stone-600{color:#57534e}.text-stone-700{color:#44403c}.text-stone-800{color:#292524}.text-stone-900{color:#1c1917}.border{border-width:1px;border-style:solid}.border-2{border-width:2px;border-style:solid}.border-black{border-color:#000}.border-stone-200{border-color:#e7e5e4}.border-stone-300{border-color:#d6d3d1}.border-l-4{border-left-width:4px;border-left-style:solid}.border-l-8{border-left-width:8px;border-left-style:solid}.rounded{border-radius:.25rem}.rounded-lg{border-radius:.5rem}.rounded-2xl{border-radius:1rem}.text-xs{font-size:.75rem}.text-sm{font-size:.875rem}.text-base{font-size:1rem}.text-lg{font-size:1.125rem}.text-xl{font-size:1.25rem}.text-2xl{font-size:1.5rem}.text-3xl{font-size:1.875rem}.text-4xl{font-size:2.25rem}.text-5xl{font-size:3rem}.font-normal{font-weight:400}.font-medium{font-weight:500}.font-semibold{font-weight:600}.font-bold{font-weight:700}.font-serif{font-family:Georgia,"Songti SC",serif}.font-sans{font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif}.leading-relaxed{line-height:1.625}.leading-tight{line-height:1.25}.tracking-wide{letter-spacing:.025em}.tracking-widest{letter-spacing:.1em}.uppercase{text-transform:uppercase}.italic{font-style:italic}.text-center{text-align:center}.text-left{text-align:left}.shadow-sm{box-shadow:0 1px 2px #0000000d}.shadow-lg{box-shadow:0 10px 15px #0000001a}`;

export function createSafeDocument({ title, content, design, fragment, htmlDocument }) {
  if (typeof htmlDocument === 'string') {
    const heading = escapeHtml(title.trim() || '未命名作品');
    const safeDocument = sanitizeHtmlDocument(htmlDocument);
    if (!safeDocument.body) throw new Error('invalid_html_document');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title><style>${safeDocument.css}</style></head><body>${safeDocument.body}</body></html>`;
  }
  if (typeof fragment === 'string') {
    const heading = escapeHtml(title.trim() || '未命名作品');
    const safeFragment = sanitizeHtmlFragment(fragment);
    if (!safeFragment.trim()) throw new Error('invalid_html_fragment');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title><style>${utilityCss}.zixian-canvas{width:100%;min-height:100vh;overflow:hidden}.zixian-canvas h1,.zixian-canvas h2,.zixian-canvas h3,.zixian-canvas p,.zixian-canvas blockquote{margin-top:0}.zixian-canvas ul,.zixian-canvas ol{padding-left:1.25rem}</style></head><body><main class="zixian-canvas">${safeFragment}</main></body></html>`;
  }

  const theme = normalizeDesign(design);
  const paragraphs = content.trim().split(/\n\s*\n/).filter(Boolean);
  const heading = escapeHtml(title.trim() || paragraphs.shift() || '未命名作品');
  const highlight = escapeHtml(paragraphs.pop() || '把真正重要的那一句，留在这里。');
  const body = paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title><style>html,body{margin:0}body{background:${theme.background};color:${theme.foreground};font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;padding:9vw;box-sizing:border-box}.label{font-size:11px;letter-spacing:.16em;opacity:.7;border-bottom:1px solid currentColor;padding-bottom:16px}.index{margin-top:64px;font-size:12px;letter-spacing:.08em;opacity:.65}h1{font-family:Georgia,"Songti SC",serif;font-size:clamp(34px,5vw,68px);line-height:1.22;letter-spacing:-.06em;margin:16px 0 34px}.rule{width:46px;height:4px;background:${theme.accent};margin-bottom:35px}p{font-size:18px;line-height:1.9;max-width:680px;margin:0 0 20px}.highlight{margin-top:70px;padding:24px;border-left:6px solid ${theme.accent};background:rgba(255,255,255,.32);font:700 clamp(21px,3vw,32px)/1.5 Georgia,"Songti SC",serif}.footer{margin-top:76px;font-size:10px;letter-spacing:.16em;opacity:.55}</style></head><body><div class="label">${theme.label}</div><div class="index">01 — VISUAL NOTE</div><h1>${heading}</h1><div class="rule"></div>${body}<div class="highlight">${highlight}</div><div class="footer">ZIXIAN / VISUAL EXPRESSION</div></body></html>`;
}
