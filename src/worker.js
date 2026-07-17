const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'zijian-api', environment: env.APP_ORIGIN ? 'configured' : 'unconfigured' });
    }

    return json({ error: 'not_found' }, { status: 404 });
  }
};
