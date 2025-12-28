const UPSTREAM = 'https://anyrouter.top';

const DEBUG_HTML = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <title>Anyrouter 动态 Cookie 调试</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; background: #0b1021; color: #e8edf4; }
    button { padding: 10px 16px; border: none; background: #14b8a6; color: #021018; border-radius: 6px; cursor: pointer; font-weight: 700; }
    button:hover { background: #0d9488; }
    pre { margin-top: 16px; padding: 12px; background: #0f172a; color: #cbd5e1; border-radius: 6px; overflow: auto; }
    a { color: #7dd3fc; }
  </style>
</head>
<body>
  <h1>Anyrouter Cookie Debugger</h1>
  <p>点击按钮触发后端请求挑战页，Eval 混淆脚本并返回当前计算出的 <code>acw_sc__v2</code>。</p>
  <button id="btn">获取 /api/user/self 的动态 Cookie</button>
  <pre id="out">等待操作…</pre>
  <script>
    const out = document.getElementById('out');
    document.getElementById('btn').onclick = async () => {
      out.textContent = '请求中...';
      const res = await fetch('/debug-cookie?target=/api/user/self');
      const data = await res.json();
      out.textContent = JSON.stringify(data, null, 2);
    };
  </script>
</body>
</html>`;

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/' || url.pathname === '/debug') {
    return new Response(DEBUG_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  if (url.pathname === '/debug-cookie') {
    const targetPath = url.searchParams.get('target') || '/api/user/self';
    const targetUrl = new URL(targetPath, UPSTREAM);
    const { cookie, error, htmlSample } = await getDynamicCookie(targetUrl);
    return Response.json({ target: targetUrl.toString(), cookie, error, htmlSample });
  }

  return proxyWithDynamicCookie(req);
});

async function proxyWithDynamicCookie(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = new URL(url.pathname + url.search, UPSTREAM);

  const { cookie, error } = await getDynamicCookie(targetUrl);
  if (!cookie) {
    return new Response(`Failed to obtain dynamic cookie: ${error || 'unknown error'}`, { status: 502 });
  }

  const headers = new Headers(req.headers);
  const existingCookie = req.headers.get('cookie');
  headers.set('cookie', [cookie, existingCookie].filter(Boolean).join('; '));
  headers.set('origin', UPSTREAM);
  headers.set('referer', `${UPSTREAM}/`);
  headers.set('host', new URL(UPSTREAM).host);
  headers.delete('content-length');

  const init: RequestInit = { method: req.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = await req.arrayBuffer();
  }

  const resp = await fetch(targetUrl.toString(), init);
  return new Response(resp.body, { status: resp.status, headers: resp.headers });
}

async function getDynamicCookie(targetUrl: URL): Promise<{ cookie: string | null; error: string | null; htmlSample?: string }> {
  try {
    const challengeResp = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'manual',
    });

    const html = await challengeResp.text();
    const { cookie, error } = extractCookieFromHtml(html);
    return { cookie, error, htmlSample: html.slice(0, 2000) };
  } catch (err) {
    return { cookie: null, error: String(err) };
  }
}

function extractCookieFromHtml(html: string): { cookie: string | null; error: string | null } {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) {
    return { cookie: null, error: 'no <script> tags found' };
  }

  let lastError: string | null = null;
  for (const match of scripts) {
    const scriptContent = match[1];
    const { cookie, error } = executeScriptForCookie(scriptContent);
    if (cookie) return { cookie, error: null };
    lastError = error;
  }

  return { cookie: null, error: lastError || 'no cookie produced' };
}

function executeScriptForCookie(scriptContent: string): { cookie: string | null; error: string | null } {
  let cookieValue: string | null = null;

  const document = {
    _cookie: '',
    set cookie(val: string) {
      this._cookie = val;
      cookieValue = val;
    },
    get cookie() {
      return this._cookie;
    },
    location: { reload() {} },
  };
  const location = document.location;
  const windowObj: Record<string, unknown> = {};
  const selfObj = windowObj;
  const navigator = {};

  try {
    const wrapped = `(function(){${scriptContent}\n})();`;
    eval(wrapped);
  } catch (err) {
    return { cookie: null, error: String(err) };
  }

  if (cookieValue) {
    return { cookie: cookieValue.split(';')[0], error: null };
  }
  return { cookie: null, error: 'script executed but did not set cookie' };
}
