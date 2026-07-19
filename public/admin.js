const shell = document.querySelector('.shell');
const denied = document.querySelector('#access-denied');

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'request_failed'), { status: response.status });
  return body;
}

function text(id, value) {
  document.querySelector(id).textContent = value;
}

function renderActivity(items) {
  const container = document.querySelector('#recent-activity');
  if (!items.length) { container.innerHTML = '<p>还没有生成记录。</p>'; return; }
  container.innerHTML = items.map(item => `<article><span>${item.email || '匿名用户'}</span><b>${item.modelLabel}</b><small>${item.costCredits} 积分 · ${item.createdAt}</small></article>`).join('');
}

function fillAiConfig(config) {
  text('#system-prompt', config.systemPrompt);
  for (const [name, provider] of Object.entries(config.providers)) {
    document.querySelector(`[data-provider="${name}"][data-field="baseUrl"]`).value = provider.baseUrl;
    text(`#${name}-status`, provider.keyConfigured ? '已配置 Key' : '使用 Worker Secret 或尚未配置');
  }
}

async function saveAiConfig(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const message = document.querySelector('#config-message');
  button.disabled = true;
  message.textContent = '正在保存…';
  const providers = {};
  for (const name of ['deepseek', 'openai', 'anthropic']) {
    providers[name] = {
      baseUrl: document.querySelector(`[data-provider="${name}"][data-field="baseUrl"]`).value,
      apiKey: document.querySelector(`[data-provider="${name}"][data-field="apiKey"]`).value
    };
  }
  try {
    const config = await api('/api/admin/ai-config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt: document.querySelector('#system-prompt').value, providers }) });
    fillAiConfig(config);
    document.querySelectorAll('[data-field="apiKey"]').forEach(input => { input.value = ''; });
    message.textContent = '已保存，后续生成会使用新配置。';
  } catch (error) {
    message.textContent = error.message === 'config_secret_unavailable' ? '请先配置 Worker Secret：ADMIN_CONFIG_KEY。' : '保存失败，请检查配置。';
  } finally { button.disabled = false; }
}

async function boot() {
  try {
    const { user } = await api('/api/admin/me');
    const [overview, aiConfig] = await Promise.all([api('/api/admin/overview'), api('/api/admin/ai-config')]);
    text('#admin-email', user.email);
    text('#users-count', overview.totals.users);
    text('#users-new', `近 24 小时新增 ${overview.today.users} 位`);
    text('#documents-count', overview.totals.documents);
    text('#documents-new', `近 24 小时新增 ${overview.today.documents} 份`);
    text('#generations-count', overview.totals.generations);
    text('#credits-used', `累计消耗 ${overview.totals.creditsUsed} 积分`);
    text('#updated-at', `更新于 ${new Date().toLocaleString('zh-CN')}`);
    renderActivity(overview.recentGenerations);
    fillAiConfig(aiConfig);
    denied.hidden = true;
    shell.hidden = false;
  } catch (error) {
    document.querySelector('#access-denied h1').textContent = error.status === 401 ? '请先登录管理员账号' : '你没有访问管理后台的权限';
  }
}

document.querySelector('#ai-config-form').addEventListener('submit', saveAiConfig);
boot();
