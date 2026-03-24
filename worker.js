/**
 * Cloudflare Worker - Hybrid CMS Reverse Proxy
 * Domain: ncflooringliquidators.com
 * Deployment: Custom Domain (not Route)
 *
 * Routes:
 *   /blog/*   → WordPress (zyvndv90k2.wpdns.site)
 *   /area/*   → WordPress
 *   /offer/*  → WordPress
 *   /*        → Go High Level (sites.ludicrous.cloud)
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  wpOrigin: 'https://zyvndv90k2.wpdns.site',
  ghlOrigin: 'https://sites.ludicrous.cloud',

  wpPaths: ['/blog', '/area', '/offer'],
  wpSystemPaths: ['/wp-content/', '/wp-includes/', '/wp-json/', '/wp-admin/'],

  publicDomain: 'ncflooringliquidators.com',

  cacheTTL: {
    html: 300,
    assets: 86400,
    api: 0,
  },
};

// ─── Main Handler ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (shouldProxyToWP(path)) {
      return handleWPRequest(request, url, ctx);
    }

    return handleGHLRequest(request, url);
  },
};

// ─── Routing Logic ───────────────────────────────────────────────────────────

function shouldProxyToWP(path) {
  const lowerPath = path.toLowerCase();

  for (const wpPath of CONFIG.wpPaths) {
    if (lowerPath === wpPath || lowerPath.startsWith(wpPath + '/')) {
      return true;
    }
  }

  for (const sysPath of CONFIG.wpSystemPaths) {
    if (lowerPath.startsWith(sysPath)) {
      return true;
    }
  }

  if (lowerPath === '/wp-login.php' || lowerPath === '/wp-cron.php' || lowerPath === '/xmlrpc.php') {
    return true;
  }

  return false;
}

// ─── GHL Proxy Handler ──────────────────────────────────────────────────────

async function handleGHLRequest(request, url) {
  const ghlURL = new URL(url.pathname + url.search, CONFIG.ghlOrigin);

  // Build a clean request with minimal headers to avoid WAF triggers
  const headers = new Headers();
  headers.set('Host', CONFIG.publicDomain);
  headers.set('Accept', request.headers.get('Accept') || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  headers.set('Accept-Language', request.headers.get('Accept-Language') || 'en-US,en;q=0.9');
  headers.set('Accept-Encoding', 'gzip');
  headers.set('User-Agent', request.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Pass through cookies for GHL functionality
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    headers.set('Cookie', cookie);
  }

  // Pass the real visitor IP
  const clientIP = request.headers.get('CF-Connecting-IP');
  if (clientIP) {
    headers.set('X-Forwarded-For', clientIP);
  }

  const proxyRequest = new Request(ghlURL.toString(), {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual',
  });

  try {
    const response = await fetch(proxyRequest);

    // Handle redirects - rewrite Location to public domain
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (location) {
        const ghlHost = new URL(CONFIG.ghlOrigin).hostname;
        const newLocation = location
          .replace(new RegExp(`https?://${escapeRegex(ghlHost)}`, 'g'), `https://${CONFIG.publicDomain}`);
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Location', newLocation);
        return new Response(null, { status: response.status, headers: newHeaders });
      }
    }

    // For HTML, rewrite GHL origin URLs to public domain
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('text/html')) {
      let body = await response.text();
      const ghlHost = new URL(CONFIG.ghlOrigin).hostname;
      body = body
        .replace(new RegExp(`https?://${escapeRegex(ghlHost)}`, 'g'), `https://${CONFIG.publicDomain}`)
        .replace(new RegExp(`//${escapeRegex(ghlHost)}`, 'g'), `//${CONFIG.publicDomain}`);

      const newHeaders = new Headers(response.headers);
      newHeaders.delete('Content-Length');
      newHeaders.set('X-Proxy', 'cf-hybrid-cms-ghl');
      return new Response(body, { status: response.status, headers: newHeaders });
    }

    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Proxy', 'cf-hybrid-cms-ghl');
    return newResponse;
  } catch (err) {
    return new Response('Service temporarily unavailable. Please try again shortly.', {
      status: 502,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

// ─── WordPress Proxy Handler ─────────────────────────────────────────────────

async function handleWPRequest(request, url, ctx) {
  const wpURL = new URL(url.pathname + url.search, CONFIG.wpOrigin);

  const headers = new Headers(request.headers);
  headers.set('Host', new URL(CONFIG.wpOrigin).hostname);
  headers.set('X-Forwarded-Host', CONFIG.publicDomain);
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');

  const proxyRequest = new Request(wpURL.toString(), {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual',
  });

  const cacheTTL = getCacheTTL(url.pathname);

  let response;
  try {
    if (cacheTTL > 0) {
      response = await fetch(proxyRequest, {
        cf: { cacheTtl: cacheTTL, cacheEverything: true },
      });
    } else {
      response = await fetch(proxyRequest);
    }
  } catch (err) {
    return new Response('Service temporarily unavailable. Please try again shortly.', {
      status: 502,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('Location');
    if (location) {
      const newLocation = rewriteURL(location);
      const redirectHeaders = new Headers(response.headers);
      redirectHeaders.set('Location', newLocation);
      return new Response(null, { status: response.status, headers: redirectHeaders });
    }
  }

  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('text/html')) {
    let body = await response.text();
    body = rewriteHTML(body);

    const newHeaders = new Headers(response.headers);
    newHeaders.delete('Content-Length');
    newHeaders.set('X-Proxy', 'cf-hybrid-cms-wp');
    return new Response(body, { status: response.status, headers: newHeaders });
  }

  if (contentType.includes('text/css')) {
    let body = await response.text();
    body = rewriteCSS(body);

    const newHeaders = new Headers(response.headers);
    newHeaders.delete('Content-Length');
    return new Response(body, { status: response.status, headers: newHeaders });
  }

  return response;
}

// ─── URL & Content Rewriting ─────────────────────────────────────────────────

function rewriteURL(urlStr) {
  if (!urlStr) return urlStr;
  const wpHost = new URL(CONFIG.wpOrigin).hostname;
  return urlStr.replace(new RegExp(`https?://${escapeRegex(wpHost)}`, 'g'), `https://${CONFIG.publicDomain}`);
}

function rewriteHTML(html) {
  const wpHost = new URL(CONFIG.wpOrigin).hostname;
  return html
    .replace(new RegExp(`https?://${escapeRegex(wpHost)}`, 'g'), `https://${CONFIG.publicDomain}`)
    .replace(new RegExp(`//${escapeRegex(wpHost)}`, 'g'), `//${CONFIG.publicDomain}`);
}

function rewriteCSS(css) {
  const wpHost = new URL(CONFIG.wpOrigin).hostname;
  return css
    .replace(new RegExp(`https?://${escapeRegex(wpHost)}`, 'g'), `https://${CONFIG.publicDomain}`)
    .replace(new RegExp(`//${escapeRegex(wpHost)}`, 'g'), `//${CONFIG.publicDomain}`);
}

// ─── Cache TTL Logic ─────────────────────────────────────────────────────────

function getCacheTTL(pathname) {
  const lower = pathname.toLowerCase();
  if (lower.startsWith('/wp-admin') || lower.startsWith('/wp-json/') ||
      lower.includes('wp-login') || lower.includes('wp-cron') ||
      lower.includes('admin-ajax')) {
    return CONFIG.cacheTTL.api;
  }
  if (lower.match(/\.(css|js|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|eot|ico)$/)) {
    return CONFIG.cacheTTL.assets;
  }
  return CONFIG.cacheTTL.html;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
