const UPSTREAM = 'https://anyrouter.top';

const DEBUG_HTML = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <title>Anyrouter 动态 Cookie 调试</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; background: #0b1021; color: #e8edf4; }
    button { padding: 10px 16px; border: none; background: #14b8a6; color: #021018; border-radius: 6px; cursor: pointer; font-weight: 700; margin-right: 8px; }
    button:hover { background: #0d9488; }
    pre { margin-top: 16px; padding: 12px; background: #0f172a; color: #cbd5e1; border-radius: 6px; overflow: auto; max-height: 400px; }
    a { color: #7dd3fc; }
    input { padding: 8px 12px; border: 1px solid #334155; background: #1e293b; color: #e8edf4; border-radius: 6px; width: 300px; margin-bottom: 8px; }
    label { display: block; margin-bottom: 4px; color: #94a3b8; font-size: 14px; }
    .section { margin-bottom: 24px; padding: 16px; background: #1e293b; border-radius: 8px; }
    h2 { margin-top: 0; color: #7dd3fc; font-size: 16px; }
  </style>
</head>
<body>
  <h1>Anyrouter Cookie Debugger</h1>

  <div class="section">
    <h2>1. 仅获取动态 Cookie</h2>
    <p>触发后端请求挑战页，Eval 混淆脚本并返回计算出的 <code>acw_sc__v2</code>。</p>
    <button id="btnCookie">获取动态 Cookie</button>
  </div>

  <div class="section">
    <h2>2. 完整用量查询</h2>
    <p>输入你的 session 和用户 ID，服务会自动处理反爬挑战并返回用量数据。</p>
    <div>
      <label>Session Cookie（不含 acw_sc__v2）</label>
      <input type="text" id="session" placeholder="从浏览器 F12 复制的 session 值" />
    </div>
    <div>
      <label>用户 ID（New-Api-User）</label>
      <input type="text" id="userId" placeholder="你的用户 ID" />
    </div>
    <button id="btnQuota">查询用量</button>
  </div>

  <pre id="out">等待操作…</pre>

  <script>
    const out = document.getElementById('out');

    document.getElementById('btnCookie').onclick = async () => {
      out.textContent = '请求中...';
      const res = await fetch('/debug-cookie?target=/api/user/self');
      const data = await res.json();
      out.textContent = JSON.stringify(data, null, 2);
    };

    document.getElementById('btnQuota').onclick = async () => {
      const session = document.getElementById('session').value.trim();
      const userId = document.getElementById('userId').value.trim();

      if (!session || !userId) {
        out.textContent = '请填写 session 和用户 ID';
        return;
      }

      out.textContent = '请求中...';
      const res = await fetch('/api/quota', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, user_id: userId })
      });
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

  // 新增：用量查询代理端点（自动处理反爬挑战）
  if (url.pathname === '/api/quota') {
    return handleQuotaRequest(req);
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

// 用量查询请求处理（接收 session 和 user_id，返回用量数据）
async function handleQuotaRequest(req: Request): Promise<Response> {
  // 只接受 POST 请求
  if (req.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed, use POST' }, { status: 405 });
  }

  let body: { session?: string; user_id?: string; target?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { session: rawSession, user_id, target = '/api/user/self' } = body;

  if (!rawSession || !user_id) {
    return Response.json({ success: false, error: 'Missing required fields: session, user_id' }, { status: 400 });
  }

  // 自动处理 session 前缀（用户可能复制了 "session=xxx" 或只是 "xxx"）
  const session = rawSession.startsWith('session=') ? rawSession.slice(8) : rawSession;

  const targetUrl = new URL(target, UPSTREAM);

  // 1. 获取动态 cookie
  const { cookie: dynamicCookie, error: cookieError } = await getDynamicCookie(targetUrl);
  if (!dynamicCookie) {
    return Response.json({ success: false, error: `获取动态 Cookie 失败: ${cookieError}` }, { status: 502 });
  }

  // 2. 组合完整 cookie 并请求用量端点
  const fullCookie = `session=${session}; ${dynamicCookie}`;

  try {
    const resp = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': fullCookie,
        'New-Api-User': user_id,
      },
    });

    const contentType = resp.headers.get('content-type') || '';
    const responseText = await resp.text();

    // 检查是否仍然是挑战页面
    if (contentType.includes('text/html') && (responseText.includes('acw_sc__v2') || responseText.includes('arg1='))) {
      return Response.json({ success: false, error: '仍然遇到反爬挑战，Cookie 可能已失效' }, { status: 502 });
    }

    // 尝试解析 JSON
    try {
      const data = JSON.parse(responseText);
      return Response.json({ success: true, data, error: null });
    } catch {
      // 非 JSON 响应，返回原始文本
      return Response.json({ success: false, error: `非 JSON 响应: ${responseText.slice(0, 500)}` }, { status: 502 });
    }
  } catch (err) {
    return Response.json({ success: false, error: `请求失败: ${String(err)}` }, { status: 502 });
  }
}
