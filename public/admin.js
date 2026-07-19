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
  container.innerHTML = items.map(item => `<article><span>${escapeHtml(item.email || '匿名用户')}</span><b>${escapeHtml(item.providerPlatform || '未记录')} / ${escapeHtml(item.providerModelName || item.modelLabel)}</b><small>${item.inputTokens + item.outputTokens} Token · ${item.attemptCount > 1 ? `已转移 ${item.attemptCount - 1} 次 · ` : ''}${item.costCredits} 积分 · ${item.createdAt}</small></article>`).join('');
}

function renderChannelRuns(items) {
  const container = document.querySelector('#channel-runs');
  if (!items.length) { container.innerHTML = '<p>还没有渠道请求记录。</p>'; return; }
  container.innerHTML = items.map(item => `<article><span>${escapeHtml(item.providerPlatform)} / ${escapeHtml(item.providerModelName)}</span><b>${item.httpStatus === 200 ? '成功' : item.errorCode || '失败'}</b><small>${item.modelLabel} · ${item.createdAt}</small></article>`).join('');
}

function fillAiConfig(config) {
  document.querySelector('#system-prompt').value = config.systemPrompt;
  renderAccounts(config.accounts);
}

function accountRow(account = {}) {
  const formatName = `format-${account.id || crypto.randomUUID()}`;
  const openai = account.apiFormat !== 'anthropic';
  return `<div class="account-row" data-id="${escapeHtml(account.id || '')}"><input data-field="platform" value="${escapeHtml(account.platform || '')}" maxlength="40" placeholder="平台，如 DeepSeek"><span class="api-format"><label><input type="radio" name="${formatName}" data-field="apiFormat" value="openai" ${openai ? 'checked' : ''}> OAI 兼容</label><label><input type="radio" name="${formatName}" data-field="apiFormat" value="anthropic" ${openai ? '' : 'checked'}> Anthropic</label></span><input data-field="baseUrl" type="url" value="${escapeHtml(account.baseUrl || '')}" placeholder="接口地址 https://..."><input data-field="modelName" value="${escapeHtml(account.modelName || '')}" maxlength="100" placeholder="模型名称"><input data-field="apiKey" type="password" autocomplete="new-password" placeholder="${account.id ? '新的 API Key（留空不变）' : 'API Key'}"><select data-field="tier"><option value="fast" ${account.tier === 'fast' ? 'selected' : ''}>快速创作</option><option value="precise" ${account.tier === 'precise' ? 'selected' : ''}>精致排版</option><option value="studio" ${account.tier === 'studio' ? 'selected' : ''}>旗舰创作</option></select><button type="button" class="remove-account">移除</button></div>`;
}

function renderAccounts(accounts = []) {
  const container = document.querySelector('#model-accounts');
  container.innerHTML = accounts.map(accountRow).join('') || '<small>尚未配置模型渠道。</small>';
}

function addAccount() {
  const container = document.querySelector('#model-accounts');
  container.querySelector('small')?.remove();
  container.insertAdjacentHTML('beforeend', accountRow());
}

async function saveAiConfig(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const message = document.querySelector('#config-message');
  button.disabled = true;
  message.textContent = '正在保存…';
  const accounts = [...document.querySelectorAll('#model-accounts .account-row')].map(row => ({
    id: row.dataset.id,
    platform: row.querySelector('[data-field="platform"]').value,
    baseUrl: row.querySelector('[data-field="baseUrl"]').value,
    modelName: row.querySelector('[data-field="modelName"]').value,
    apiKey: row.querySelector('[data-field="apiKey"]').value,
    apiFormat: row.querySelector('[data-field="apiFormat"]:checked').value,
    tier: row.querySelector('[data-field="tier"]').value
  }));
  try {
    const config = await api('/api/admin/ai-config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt: document.querySelector('#system-prompt').value, accounts }) });
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
    renderChannelRuns(overview.recentChannelRuns);
    fillAiConfig(aiConfig);
    denied.hidden = true;
    shell.hidden = false;
  } catch (error) {
    document.querySelector('#access-denied h1').textContent = error.status === 401 ? '请先登录管理员账号' : '你没有访问管理后台的权限';
  }
}

document.querySelector('#ai-config-form').addEventListener('submit', saveAiConfig);
document.querySelector('#ai-config-form').addEventListener('click', event => {
  if (event.target.matches('.add-account')) addAccount();
  if (event.target.matches('.remove-account')) event.target.closest('.account-row').remove();
});
boot();
