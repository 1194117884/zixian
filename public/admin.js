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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function renderActivity(items) {
  const container = document.querySelector('#recent-activity');
  if (!items.length) { container.innerHTML = '<p>还没有生成记录。</p>'; return; }
  container.innerHTML = items.map(item => `<article><span>${item.email || '匿名用户'}</span><b>${item.modelLabel}</b><small>${item.costCredits} 积分 · ${item.createdAt}</small></article>`).join('');
}

function fillAiConfig(config) {
  document.querySelector('#system-prompt').value = config.systemPrompt;
  for (const [name, provider] of Object.entries(config.providers)) {
    renderProviderAccounts(name, provider.accounts);
  }
}

function renderProviderAccounts(name, accounts = []) {
  const container = document.querySelector(`#${name}-accounts`);
  const editable = accounts.filter(account => account.id !== 'worker-secret');
  const workerSecret = accounts.some(account => account.id === 'worker-secret');
  container.innerHTML = editable.map(account => `<div class="account-row" data-id="${escapeHtml(account.id)}"><input data-field="label" value="${escapeHtml(account.label)}" maxlength="40" placeholder="账号名称"><input data-field="baseUrl" type="url" value="${escapeHtml(account.baseUrl)}" placeholder="https://..."><input data-field="apiKey" type="password" autocomplete="new-password" placeholder="新的 API Key（留空不变）"><button type="button" class="remove-account">移除</button></div>`).join('') || `<small>${workerSecret ? '当前使用 Worker Secret；添加账号后将改用后台账号池。' : '尚未配置账号。'}</small>`;
}

function addProviderAccount(name) {
  const container = document.querySelector(`#${name}-accounts`);
  container.querySelector('small')?.remove();
  const row = document.createElement('div');
  row.className = 'account-row';
  row.dataset.id = '';
  row.innerHTML = '<input data-field="label" maxlength="40" placeholder="账号名称"><input data-field="baseUrl" type="url" placeholder="https://..."><input data-field="apiKey" type="password" autocomplete="new-password" placeholder="API Key"><button type="button" class="remove-account">移除</button>';
  container.append(row);
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
      accounts: [...document.querySelectorAll(`#${name}-accounts .account-row`)].map(row => ({
        id: row.dataset.id,
        label: row.querySelector('[data-field="label"]').value,
        baseUrl: row.querySelector('[data-field="baseUrl"]').value,
        apiKey: row.querySelector('[data-field="apiKey"]').value
      }))
    };
  }
  try {
    const config = await api('/api/admin/ai-config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt: document.querySelector('#system-prompt').value, providers }) });
    fillAiConfig(config);
    document.querySelectorAll('.account-row [data-field="apiKey"]').forEach(input => { input.value = ''; });
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
document.querySelector('.provider-grid').addEventListener('click', event => {
  if (event.target.matches('.add-account')) addProviderAccount(event.target.dataset.provider);
  if (event.target.matches('.remove-account')) event.target.closest('.account-row').remove();
});
boot();
