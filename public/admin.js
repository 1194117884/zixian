const shell = document.querySelector('.shell');
const denied = document.querySelector('#access-denied');

async function api(path) {
  const response = await fetch(path, { credentials: 'same-origin' });
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

async function boot() {
  try {
    const { user } = await api('/api/admin/me');
    const overview = await api('/api/admin/overview');
    text('#admin-email', user.email);
    text('#users-count', overview.totals.users);
    text('#users-new', `近 24 小时新增 ${overview.today.users} 位`);
    text('#documents-count', overview.totals.documents);
    text('#documents-new', `近 24 小时新增 ${overview.today.documents} 份`);
    text('#generations-count', overview.totals.generations);
    text('#credits-used', `累计消耗 ${overview.totals.creditsUsed} 积分`);
    text('#updated-at', `更新于 ${new Date().toLocaleString('zh-CN')}`);
    renderActivity(overview.recentGenerations);
    denied.hidden = true;
    shell.hidden = false;
  } catch (error) {
    document.querySelector('#access-denied h1').textContent = error.status === 401 ? '请先登录管理员账号' : '你没有访问管理后台的权限';
  }
}

boot();
