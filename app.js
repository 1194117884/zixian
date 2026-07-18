const content = document.querySelector('#content');
const instruction = document.querySelector('#instruction');
const count = document.querySelector('#count');
const preview = document.querySelector('#preview');
const toast = document.querySelector('#toast');
const authDialog = document.querySelector('#auth-dialog');
const emailForm = document.querySelector('#email-form');
const authMessage = document.querySelector('#auth-message');
const paymentDialog = document.querySelector('#payment-dialog');
const styleNames = { note: 'Apple Notes', board: '手写板书', magazine: '编辑杂志', social: '知识卡片' };
let selectedStyle = 'note';
let currentUser = null;
let currentDocumentId = null;
let authStage = 'request';
let resendTimer = null;
let selectedModelId = 'fast';
let availableModels = [];
let hasGenerated = false;
let versionCount = 0;
let selectedTone = 'original';
let conversationHistory = [];

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || 'request_failed'), { code: body.error, status: response.status });
  return body;
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
  const tones = {
    original: {},
    vivid: { bg:'#3b146f', ink:'#fff8ff', top:'VIVID / ZIXIAN', accent:'#58f4dc' },
    night: { bg:'#13162a', ink:'#eff2ff', top:'NIGHT / ZIXIAN', accent:'#8c9eff' },
    warm: { bg:'#f7d9bc', ink:'#48251e', top:'WARM / ZIXIAN', accent:'#ef6a4a' },
    cool: { bg:'#cfe5ef', ink:'#173847', top:'COOL / ZIXIAN', accent:'#247c9d' }
  };
  const t = { ...themes[selectedStyle], ...tones[selectedTone] };
  const paragraphs = body.map((block, index) => `<p class="body ${index === 0 ? 'first' : ''}">${block}</p>`).join('');
  preview.srcdoc = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:38px 31px;min-height:100vh;background:${t.bg};color:${t.ink};font-family:${t.font};display:flex;flex-direction:column}.top{font:600 9px Arial;letter-spacing:.18em;opacity:.68;border-bottom:1px solid currentColor;padding-bottom:14px}.number{font:10px Arial;letter-spacing:.1em;margin-top:30px;opacity:.65}.title{font-size:${selectedStyle === 'board' ? '29' : '25'}px;line-height:1.24;letter-spacing:-.06em;margin:9px 0 20px;font-weight:800}.body{font-size:13px;line-height:1.85;margin:0 0 15px}.first:first-letter{font-size:1.35em;font-weight:bold}.highlight{margin-top:auto;padding:14px 14px 15px;border-left:4px solid ${t.accent};background:rgba(255,255,255,.34);font-size:15px;line-height:1.55;font-weight:700;letter-spacing:-.03em}.foot{font:9px Arial;letter-spacing:.12em;opacity:.55;margin-top:25px}.line{width:33px;height:3px;background:${t.accent};margin:3px 0 20px}</style></head><body><div class="top">${t.top}</div><div class="number">01 — 想法记录</div><h1 class="title">${title}</h1><div class="line"></div>${paragraphs}<div class="highlight">${highlight}</div><div class="foot">ZIXIAN / VISUAL NOTE</div></body></html>`;
}

function addConversationMessage(role, text) {
  const conversation = document.querySelector('#conversation');
  conversation.hidden = false;
  const message = document.createElement('article');
  message.className = `conversation-message ${role}`;
  message.innerHTML = role === 'user'
    ? `<span>你</span><p>${escapeHtml(text)}</p>`
    : `<span>字见</span><p>${escapeHtml(text)}</p>`;
  conversation.append(message);
  conversation.scrollTop = conversation.scrollHeight;
  return message;
}

function addPreviewToMessage(message) {
  const bubble = document.createElement('div');
  bubble.className = 'document-bubble';
  const iframe = document.createElement('iframe');
  iframe.title = `第 ${versionCount} 版作品预览`;
  iframe.sandbox = '';
  iframe.srcdoc = preview.srcdoc;
  bubble.append(iframe);
  message.append(bubble);
}

function showGeneratedDocument() {
  hasGenerated = true;
  versionCount += 1;
  document.querySelector('#source-content').hidden = true;
  document.querySelector('#prompt-label').textContent = '继续修改';
  document.querySelector('#instruction').placeholder = '例如：标题更有力量，正文更精简，结尾更克制。';
  document.querySelector('#generate-hint').textContent = '⌘ Enter 修改';
}

function resetCreation() {
  hasGenerated = false;
  versionCount = 0;
  selectedTone = 'original';
  conversationHistory = [];
  currentDocumentId = null;
  document.querySelector('#source-content').hidden = false;
  document.querySelector('#conversation').replaceChildren();
  document.querySelector('#conversation').hidden = true;
  document.querySelector('#prompt-label').textContent = '生成要求';
  document.querySelector('#instruction').placeholder = '补充你的生成要求（可选）';
  document.querySelector('#generate-hint').textContent = '⌘ Enter 生成';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2400);
}

function updateGenerateButton() {
  const model = availableModels.find(item => item.id === selectedModelId);
  document.querySelector('#generate').innerHTML = `生成作品 <span>✦ ${model?.credits ?? 6}</span>`;
}

function renderModelOptions(models) {
  const container = document.querySelector('#model-options');
  if (!models.length) { container.innerHTML = '<span class="model-loading">模型暂不可用，请刷新重试。</span>'; return; }
  availableModels = models;
  if (!models.some(model => model.id === selectedModelId)) selectedModelId = models[0].id;
  container.innerHTML = models.map(model => `<button class="model-option${model.id === selectedModelId ? ' selected' : ''}" type="button" data-model-id="${escapeHtml(model.id)}"><span class="model-option-top"><b>${escapeHtml(model.label)}</b><small>${escapeHtml(model.speed || '—')}</small></span><span class="model-name">${escapeHtml(model.modelName || model.label)}</span><span class="model-description">${escapeHtml(model.description || '按所选设计语言整理内容。')}</span><span class="model-credits">✦ ${model.credits} 积分</span></button>`).join('');
  updateGenerateButton();
}

async function loadModels() {
  const response = await api(`/api/models?fresh=${Date.now()}`);
  renderModelOptions(response.models);
}

function updateProfile(user) {
  currentUser = user;
  document.querySelector('#profile-name').textContent = user ? user.email : '登录以保存作品';
  document.querySelector('#profile-detail').textContent = user ? '个人创作空间' : '登录后可发布与导出';
  document.querySelector('#avatar').textContent = user ? user.email.slice(0, 1).toUpperCase() : '字';
  if (!user) document.querySelector('#credit-balance').textContent = '—';
}

async function loadWallet() {
  if (!currentUser) return;
  const wallet = await api('/api/wallet');
  document.querySelector('#credit-balance').textContent = wallet.balance;
}

function openLogin() {
  authMessage.textContent = '';
  authMessage.classList.remove('error');
  authDialog.showModal();
  document.querySelector('#email').focus();
}

function setAuthMessage(message, isError = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle('error', isError);
}

function chooseStyle(style, label = styleNames[style]) {
  if (!styleNames[style]) return;
  selectedStyle = style;
  if (!hasGenerated) currentDocumentId = null;
  document.querySelectorAll('.style-card').forEach(item => item.classList.toggle('selected', item.dataset.style === style));
  if (!hasGenerated) renderDocument();
}

function renderStyleLibrary(styles) {
  const container = document.querySelector('#style-results');
  if (!styles.length) { container.innerHTML = '<p class="library-empty">还没有公开风格。发布你的第一份作品吧。</p>'; return; }
  container.innerHTML = styles.map(item => `<article class="library-card" data-template-id="${escapeHtml(item.id)}" data-style="${escapeHtml(item.style)}"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description || styleNames[item.style] || '')}</p><div class="library-meta"><span>${escapeHtml(item.author || '字见用户')}</span><span>♥ ${item.likes}</span><span>↗ ${item.uses}</span></div><div class="library-actions"><button class="like-style" type="button">${item.liked ? '已喜欢' : '喜欢'}</button><button class="use-style" type="button">使用风格</button></div></article>`).join('');
}

async function loadStyleLibrary() {
  const query = document.querySelector('#style-search').value.trim();
  const response = await api(`/api/styles${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  renderStyleLibrary(response.styles);
}

function startResendCountdown(seconds = 60) {
  const countdown = document.querySelector('#resend-countdown');
  const resend = document.querySelector('#resend-code');
  clearInterval(resendTimer);
  resend.disabled = true;
  const render = () => { countdown.textContent = seconds > 0 ? `${seconds}s 后可重发` : '可重发'; };
  render();
  resendTimer = setInterval(() => {
    seconds -= 1;
    render();
    if (seconds <= 0) { clearInterval(resendTimer); resend.disabled = false; }
  }, 1000);
}

function showCodeStep() {
  authStage = 'verify';
  document.querySelector('#code-field').hidden = false;
  document.querySelector('#code').required = true;
  document.querySelector('#auth-submit').textContent = '登录';
  document.querySelector('#code').focus();
  startResendCountdown();
}

async function requireLogin() {
  if (currentUser) return true;
  openLogin();
  return false;
}

async function saveDocument() {
  if (!await requireLogin()) return null;
  if (!content.value.trim()) {
    showToast('先写下一点想表达的内容吧');
    return null;
  }
  const saved = await api('/api/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: content.value.trim().split(/\n/)[0].slice(0, 80), content: content.value, style: selectedStyle, instruction: instruction.value }) });
  currentDocumentId = saved.id;
  return saved;
}

content.addEventListener('input', () => { count.textContent = content.value.length; if (!hasGenerated) { currentDocumentId = null; renderDocument(); } });
document.querySelector('#styles').addEventListener('click', event => {
  const card = event.target.closest('.style-card');
  if (!card) return;
  chooseStyle(card.dataset.style);
  showToast(`已切换为「${styleNames[selectedStyle]}」设计语言`);
});
document.querySelector('#generate').addEventListener('click', async () => {
  if (!await requireLogin()) return;
  if (!content.value.trim()) return showToast('先写下一点想表达的内容吧');
  if (hasGenerated && !instruction.value.trim()) return showToast('告诉我这一版还想怎样调整');
  const button = document.querySelector('#generate');
  button.disabled = true;
  const initialGeneration = !hasGenerated;
  const direction = instruction.value.trim();
  button.textContent = hasGenerated ? '正在修改…' : '正在生成…';
  if (hasGenerated && direction) addConversationMessage('user', direction);
  try {
    const result = await api('/api/generation-jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ modelId: selectedModelId, documentId: currentDocumentId || undefined, title: content.value.trim().split(/\n/)[0], content: content.value, instruction: instruction.value, style: selectedStyle, history: [...conversationHistory, { role: 'user', content: direction || '请生成第一版视觉作品。' }] })
    });
    content.value = [result.composition.title, ...result.composition.paragraphs, result.composition.highlight].join('\n\n');
    count.textContent = content.value.length;
    currentDocumentId = result.document.id;
    selectedTone = result.composition.visualTone || 'original';
    renderDocument();
    showGeneratedDocument();
    if (initialGeneration) addConversationMessage('user', direction || '请将这段内容制作为可分享的视觉作品。');
    const responseMessage = addConversationMessage('assistant', `第 ${versionCount} 版已完成。你可以继续告诉我想调整的内容。`);
    addPreviewToMessage(responseMessage);
    conversationHistory.push({ role: 'user', content: direction || '请生成第一版视觉作品。' }, { role: 'assistant', content: JSON.stringify(result.composition) });
    instruction.value = '';
    await loadWallet();
    showToast('作品已生成并安全保存');
  } catch (error) {
    showToast(error.code === 'insufficient_credits' ? '积分不足，请先充值' : '生成失败，积分已退回');
  } finally {
    button.disabled = false;
    updateGenerateButton();
  }
});
document.querySelector('#model-options').addEventListener('click', event => {
  const option = event.target.closest('.model-option');
  if (!option) return;
  selectedModelId = option.dataset.modelId;
  renderModelOptions(availableModels);
});
document.querySelector('#clear-instruction').addEventListener('click', () => { instruction.value = ''; instruction.focus(); });
document.querySelector('#share').addEventListener('click', async () => {
  try {
    if (!currentDocumentId) await saveDocument();
    if (!currentDocumentId) return;
    const page = await api(`/api/documents/${currentDocumentId}/publish`, { method: 'POST' });
    document.querySelector('.share-url code').textContent = page.url;
    document.querySelector('#share-dialog').showModal();
  } catch { showToast('发布失败，请稍后重试'); }
});
document.querySelector('#export').addEventListener('click', async () => {
  try {
    if (!currentDocumentId) await saveDocument();
    if (!currentDocumentId) return;
    showToast('正在生成高清图…');
    const output = await api(`/api/documents/${currentDocumentId}/exports`, { method: 'POST' });
    window.location.assign(output.downloadUrl);
  } catch { showToast('导出暂不可用，请稍后重试'); }
});
document.querySelector('#publish-style').addEventListener('click', async () => {
  try {
    if (!await requireLogin()) return;
    if (!currentDocumentId) await saveDocument();
    if (!currentDocumentId) return;
    await api(`/api/documents/${currentDocumentId}/styles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: instruction.value }) });
    showToast('已发布到风格库');
  } catch (error) { showToast(error.code === 'already_published' ? '这份作品已经发布为风格' : '风格发布失败，请稍后重试'); }
});
document.querySelector('#open-style-library').addEventListener('click', async event => {
  event.preventDefault();
  document.querySelector('#style-library-dialog').showModal();
  try { await loadStyleLibrary(); } catch { showToast('风格库暂不可用，请稍后重试'); }
});
document.querySelector('#close-style-library').addEventListener('click', () => document.querySelector('#style-library-dialog').close());
document.querySelector('#style-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await loadStyleLibrary(); } catch { showToast('搜索失败，请稍后重试'); }
});
document.querySelector('#style-results').addEventListener('click', async event => {
  const card = event.target.closest('.library-card');
  if (!card) return;
  try {
    if (event.target.closest('.like-style')) {
      if (!await requireLogin()) return;
      const result = await api(`/api/styles/${card.dataset.templateId}/like`, { method: 'POST' });
      card.querySelector('.like-style').textContent = result.liked ? '已喜欢' : '喜欢';
      card.querySelector('.library-meta span:nth-child(2)').textContent = `♥ ${result.likes}`;
    }
    if (event.target.closest('.use-style')) {
      if (!await requireLogin()) return;
      const result = await api(`/api/styles/${card.dataset.templateId}/use`, { method: 'POST' });
      chooseStyle(result.style.style, result.style.title);
      document.querySelector('#style-library-dialog').close();
      showToast(`已应用「${result.style.title}」`);
    }
  } catch { showToast('操作失败，请稍后重试'); }
});
document.querySelector('#close-dialog').addEventListener('click', () => document.querySelector('#share-dialog').close());
document.querySelector('#copy-link').addEventListener('click', async () => {
  await navigator.clipboard?.writeText(document.querySelector('.share-url code').textContent);
  showToast('分享链接已复制');
});
document.querySelector('#new-work').addEventListener('click', () => {
  content.value = ''; instruction.value = ''; count.textContent = '0'; resetCreation(); renderDocument(); content.focus(); showToast('已新建空白作品');
});
document.querySelector('#login').addEventListener('click', () => currentUser ? api('/api/auth/logout', { method: 'POST' }).then(() => { updateProfile(null); currentDocumentId = null; showToast('已登出'); }) : openLogin());
document.querySelector('#buy-credits').addEventListener('click', async () => {
  if (!await requireLogin()) return;
  document.querySelector('#payment-message').textContent = '';
  paymentDialog.showModal();
});
document.querySelector('#close-payment').addEventListener('click', () => paymentDialog.close());
document.querySelector('#complete-test-payment').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '正在处理充值…';
  try {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const payment = await api('/api/test-payments', { method: 'POST' });
    document.querySelector('#credit-balance').textContent = payment.balance;
    document.querySelector('#payment-message').textContent = `充值成功，已到账 ${payment.credits} 积分。`;
    showToast(`充值成功 · +${payment.credits} 积分`);
    setTimeout(() => paymentDialog.close(), 900);
  } catch (error) {
    document.querySelector('#payment-message').textContent = error.code === 'test_payments_disabled' ? '充值暂不可用，请稍后重试。' : '充值失败，请稍后重试。';
  } finally {
    button.disabled = false;
    button.textContent = '确认充值';
  }
});
document.querySelector('#close-auth').addEventListener('click', () => authDialog.close());
emailForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#auth-submit');
  button.disabled = true;
  try {
    if (authStage === 'request') {
      await api('/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.querySelector('#email').value }) });
      setAuthMessage('验证码已发送，请查收邮箱。'); showCodeStep();
    } else {
      const result = await api('/api/auth/verify-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.querySelector('#email').value, code: document.querySelector('#code').value }) });
      updateProfile(result.user); await loadWallet(); authDialog.close(); showToast('登录成功，作品会安全保存');
    }
  } catch (error) {
    setAuthMessage(authStage === 'request' && error.code === 'rate_limited' ? '请求过于频繁，请稍后再试。' : authStage === 'request' ? '无法发送验证码，请检查邮箱。' : '验证码无效或已过期。', true);
  } finally { button.disabled = false; }
});
document.querySelector('#resend-code').addEventListener('click', async event => {
  const resend = event.currentTarget;
  resend.disabled = true;
  try {
    await api('/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.querySelector('#email').value }) });
    setAuthMessage('验证码已重新发送，请查收邮箱。'); startResendCountdown();
  } catch (error) {
    setAuthMessage(error.code === 'rate_limited' ? '请求过于频繁，请稍后再试。' : '无法重新发送验证码。', true);
    resend.disabled = false;
  }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') document.querySelector('#generate').click(); });

api('/api/auth/me').then(async result => { updateProfile(result.user); await loadWallet(); }).catch(() => updateProfile(null));
loadModels().catch(() => renderModelOptions([]));
