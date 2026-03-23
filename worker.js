/**
 * Cloudflare Worker - Hybrid CMS Reverse Proxy
 * Domain: ncflooringliquidators.com
 *
 * Routes:
 *   /blog/*   → WordPress (zyvndv90k2.wpdns.site)
 *   /area/*   → WordPress
 *   /offer/*  → WordPress
 *   /*        → Go High Level (origin / passthrough)
 *
 * Features:
 *   - Transparent proxying (visitor sees ncflooringliquidators.com URLs only)
 *   - SEO-safe headers (canonical preserved, no noindex injected)
 *   - Asset rewriting (wp-content, wp-includes served from WP)
 *   - Cache-friendly with configurable TTLs
 *   - Proper handling of WordPress admin, REST API, and AJAX
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  // WordPress origin
  wpOrigin: 'https://zyvndv90k2.wpdns.site',

  // Go High Level origin (explicit, since Custom Domain replaces DNS origin)
  ghlOrigin: 'https://sites.ludicrous.cloud',

  // Paths that should be served from WordPress
  wpPaths: ['/blog', '/area', '/offer'],

  // WordPress asset/system paths (always proxy to WP when these appear)
  wpSystemPaths: ['/wp-content/', '/wp-includes/', '/wp-json/', '/wp-admin/'],

  // The public-facing domain
  publicDomain: 'ncflooringliquidators.com',

  // Cache TTLs (seconds)
  cacheTTL: {
    html: 300,       // 5 minutes for HTML pages
    assets: 86400,   // 24 hours for CSS/JS/images
    api: 0,          // No cache for API/AJAX
  },
};

// ─── Main Handler ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Determine if this request should go to WordPress
    if (shouldProxyToWP(path)) {
      return handleWPRequest(request, url, ctx);
    }

    // Everything else goes to GHL
    return handleGHLRequest(request, url);
  },
};

// ─── Routing Logic ───────────────────────────────────────────────────────────

function shouldProxyToWP(path) {
  const lowerPath = path.toLowerCase();

  // Check WordPress content paths (blog, area, offer)
  for (const wpPath of CONFIG.wpPaths) {
    if (lowerPath === wpPath || lowerPath.startsWith(wpPath + '/')) {
      return true;
    }
  }

  // Check WordPress system/asset paths
  for (const sysPath of CONFIG.wpSystemPaths) {
    if (lowerPath.startsWith(sysPath)) {
      return true;
    }
  }

  // WordPress AJAX handler
  if (lowerPath === '/wp-login.php' || lowerPath === '/wp-cron.php' || lowerPath === '/xmlrpc.php') {
    return true;
  }

  return false;
}

// ─── GHL Proxy Handler ───────────────────────────────────────────────────────

async function handleGHLRequest(request, url) {
  // Build the GHL URL
  const ghlURL = new URL(url.pathname + url.search, CONFIG.ghlOrigin);

  // Clone headers and set Host to the public domain (GHL expects this)
  const headers = new Headers(request.headers);
  headers.set('Host', CONFIG.publicDomain);
  headers.set('X-Forwarded-Proto', 'https');

  const proxyRequest = new Request(ghlURL.toString(), {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual',
  });

  try {
    const response = await fetch(proxyRequest);

    // Rewrite redirect Location headers if they reference the GHL origin
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (location) {
        const ghlHost = new URL(CONFIG.ghlOrigin).hostname;
        const newLocation = location.replace(
          new RegExp(`https?://${escapeRegex(ghlHost)}`, 'g'),
          `https://${CONFIG.publicDomain}`
        );
        const redirectHeaders = new Headers(response.headers);
        redirectHeaders.set('Location', newLocation);
        return new Response(null, {
          status: response.status,
          headers: redirectHeaders,
        });
      }
    }

    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Proxy', 'cf-hybrid-cms-ghl');
    return newResponse;
  } catch (err) {
    return new Response('Service temporarily unavailable.', {
      status: 502,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

// ─── WordPress Proxy Handler ─────────────────────────────────────────────────

async function handleWPRequest(request, url, ctx) {
  // Build the WordPress URL
  const wpURL = new URL(url.pathname + url.search, CONFIG.wpOrigin);

  // Clone headers and set the Host header to the WP origin
  const headers = new Headers(request.headers);
  headers.set('Host', new URL(CONFIG.wpOrigin).hostname);
  headers.set('X-Forwarded-Host', CONFIG.publicDomain);
  headers.set('X-Forwarded-Proto', 'https');
  headers.set('X-Real-IP', request.headers.get('CF-Connecting-IP') || '');

  // Build the proxy request
  const proxyRequest = new Request(wpURL.toString(), {
    method: request.method,
    headers: headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual', // Handle redirects ourselves
  });

  // Determine cache settings based on content type
  const cacheTTL = getCacheTTL(url.pathname);

  let response;
  try {
    if (cacheTTL > 0) {
      response = await fetch(proxyRequest, {
        cf: {
          cacheTtl: cacheTTL,
          cacheEverything: true,
        },
      });
    } else {
      response = await fetch(proxyRequest);
    }
  } catch (err) {
    // If WordPress is down, return a friendly error
    return new Response('Service temporarily unavailable. Please try again shortly.', {
      status: 502,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Handle redirects - rewrite Location header to use public domain
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('Location');
    if (location) {
      const newLocation = rewriteURL(location);
      const redirectHeaders = new Headers(response.headers);
      redirectHeaders.set('Location', newLocation);
      return new Response(null, {
        status: response.status,
        headers: redirectHeaders,
      });
    }
  }

  // For HTML responses, rewrite URLs in the body
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('text/html')) {
    let body = await response.text();
    body = rewriteHTML(body);

    const newHeaders = new Headers(response.headers);
    // Remove any headers that might cause issues
    newHeaders.delete('Content-Length'); // Will be recalculated
    newHeaders.set('X-Proxy', 'cf-hybrid-cms');

    return new Response(body, {
      status: response.status,
      headers: newHeaders,
    });
  }

  // For CSS files, rewrite url() references
  if (contentType.includes('text/css')) {
    let body = await response.text();
    body = rewriteCSS(body);

    const newHeaders = new Headers(response.headers);
    newHeaders.delete('Content-Length');
    return new Response(body, {
      status: response.status,
      headers: newHeaders,
    });
  }

  // For all other content (images, JS, fonts, etc.), pass through as-is
  return response;
}

// ─── URL & Content Rewriting ─────────────────────────────────────────────────

/**
 * Rewrite a single URL string from WP origin to public domain
 */
function rewriteURL(urlStr) {
  if (!urlStr) return urlStr;

  const wpHost = new URL(CONFIG.wpOrigin).hostname;

  // Replace WordPress origin URLs with public domain
  return urlStr
    .replace(new RegExp(`https?://${escapeRegex(wpHost)}`, 'g'), `https://${CONFIG.publicDomain}`);
}

/**
 * Rewrite HTML body - replace all WordPress origin references
 */
function rewriteHTML(html) {
  const wpHost = new URL(CONFIG.wpOrigin).hostname;

  return html
    // Replace full URLs
    .replace(new RegExp(`https?://${escapeRegex(wpHost)}`, 'g'), `https://${CONFIG.publicDomain}`)
    // Replace protocol-relative URLs
    .replace(new RegExp(`//${escapeRegex(wpHost)}`, 'g'), `//${CONFIG.publicDomain}`);
}

/**
 * Rewrite CSS url() references
 */
function rewriteCSS(css) {
  const wpHost = new URL(CONFIG.wpOrigin).hostname;

  return css
    .replace(new RegExp(`https?://${escapeRegex(wpHost)}`, 'g'), `https://${CONFIG.publicDomain}`)
    .replace(new RegExp(`//${escapeRegex(wpHost)}`, 'g'), `//${CONFIG.publicDomain}`);
}

// ─── Cache TTL Logic ─────────────────────────────────────────────────────────

function getCacheTTL(pathname) {
  const lower = pathname.toLowerCase();

  // No caching for admin, AJAX, REST API, login
  if (lower.startsWith('/wp-admin') || lower.startsWith('/wp-json/') ||
      lower.includes('wp-login') || lower.includes('wp-cron') ||
      lower.includes('admin-ajax')) {
    return CONFIG.cacheTTL.api;
  }

  // Long cache for static assets
  if (lower.match(/\.(css|js|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|eot|ico)$/)) {
    return CONFIG.cacheTTL.assets;
  }

  // Short cache for HTML pages
  return CONFIG.cacheTTL.html;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
