const content = document.querySelector('#content');
const instruction = document.querySelector('#instruction');
const count = document.querySelector('#count');
const styleName = document.querySelector('#style-name');
const preview = document.querySelector('#preview');
const paper = document.querySelector('#paper-wrap');
const toast = document.querySelector('#toast');
const styleNames = { note: 'Apple Notes', board: '手写板书', magazine: '编辑杂志', social: '知识卡片' };
let selectedStyle = 'note';
let zoom = 67;

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function renderDocument() {
  const blocks = escapeHtml(content.value.trim() || '你的想法会出现在这里。').split(/\n\s*\n/).filter(Boolean);
  const title = blocks[0] || '让真正重要的那一句，被看见。';
  const body = blocks.slice(1);
  const highlight = body.pop() || '信息越多的时候，留白越是一种能力。';
  const themes = {
    note: { bg:'#f8e96a', ink:'#312f19', font:'Arial, sans-serif', top:'NOTES', accent:'#fff9a8' },
    board: { bg:'#ece1d3', ink:'#2b2926', font:'Georgia, serif', top:'观点板书', accent:'#d95242' },
    magazine: { bg:'#f5f2eb', ink:'#1c1b19', font:'Georgia, serif', top:'JIAN  /  04', accent:'#1c1b19' },
    social: { bg:'#c6d9cc', ink:'#16362b', font:'Arial, sans-serif', top:'IDEA CARD', accent:'#f4ec75' }
  };
  const t = themes[selectedStyle];
  const paragraphs = body.map((block, index) => `<p class="body ${index === 0 ? 'first' : ''}">${block}</p>`).join('');
  preview.srcdoc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:38px 31px;min-height:100vh;background:${t.bg};color:${t.ink};font-family:${t.font};display:flex;flex-direction:column}.top{font:600 9px Arial;letter-spacing:.18em;opacity:.68;border-bottom:1px solid currentColor;padding-bottom:14px}.number{font:10px Arial;letter-spacing:.1em;margin-top:30px;opacity:.65}.title{font-size:${selectedStyle === 'board' ? '29' : '25'}px;line-height:1.24;letter-spacing:-.06em;margin:9px 0 20px;font-weight:800}.body{font-size:13px;line-height:1.85;margin:0 0 15px}.first:first-letter{font-size:1.35em;font-weight:bold}.highlight{margin-top:auto;padding:14px 14px 15px;border-left:4px solid ${t.accent};background:rgba(255,255,255,.34);font-size:15px;line-height:1.55;font-weight:700;letter-spacing:-.03em}.foot{font:9px Arial;letter-spacing:.12em;opacity:.55;margin-top:25px}.line{width:33px;height:3px;background:${t.accent};margin:3px 0 20px}</style></head><body><div class="top">${t.top}</div><div class="number">01 — 想法记录</div><h1 class="title">${title}</h1><div class="line"></div>${paragraphs}<div class="highlight">${highlight}</div><div class="foot">ZIJIAN / VISUAL NOTE</div></body></html>`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2400);
}

content.addEventListener('input', () => { count.textContent = content.value.length; renderDocument(); });
document.querySelector('#styles').addEventListener('click', event => {
  const card = event.target.closest('.style-card');
  if (!card) return;
  selectedStyle = card.dataset.style;
  document.querySelectorAll('.style-card').forEach(item => item.classList.toggle('selected', item === card));
  styleName.textContent = styleNames[selectedStyle];
  renderDocument();
  showToast(`已切换为「${styleNames[selectedStyle]}」设计语言`);
});
document.querySelector('#generate').addEventListener('click', () => {
  if (!content.value.trim()) return showToast('先写下一点想表达的内容吧');
  renderDocument();
  showToast('作品已生成 · 已扣除 6 积分');
});
document.querySelector('#clear-instruction').addEventListener('click', () => { instruction.value = ''; instruction.focus(); });
document.querySelector('#share').addEventListener('click', () => document.querySelector('#share-dialog').showModal());
document.querySelector('#close-dialog').addEventListener('click', () => document.querySelector('#share-dialog').close());
document.querySelector('#copy-link').addEventListener('click', async () => {
  await navigator.clipboard?.writeText('https://m7k2q.zijian.page');
  showToast('分享链接已复制');
});
document.querySelector('#export').addEventListener('click', () => showToast('正在生成高清图 · 完成后将自动下载'));
document.querySelector('#new-work').addEventListener('click', () => {
  content.value = '';
  instruction.value = '';
  count.textContent = '0';
  renderDocument();
  content.focus();
  showToast('已新建空白作品');
});
document.querySelector('#zoom-in').addEventListener('click', () => { zoom = Math.min(100, zoom + 11); paper.style.transform = `scale(${zoom / 67})`; document.querySelector('#zoom').textContent = `${zoom}%`; });
document.querySelector('#zoom-out').addEventListener('click', () => { zoom = Math.max(45, zoom - 11); paper.style.transform = `scale(${zoom / 67})`; document.querySelector('#zoom').textContent = `${zoom}%`; });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') document.querySelector('#generate').click(); });
renderDocument();
