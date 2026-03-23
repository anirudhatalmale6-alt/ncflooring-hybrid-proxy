# Hybrid CMS Reverse Proxy - Setup Guide
## ncflooringliquidators.com (GHL + WordPress)

### How It Works

```
Visitor → ncflooringliquidators.com
            ↓
      Cloudflare Worker
       /    |    \
      /     |     \
   /blog  /area  /offer  →  WordPress (zyvndv90k2.wpdns.site)
   Everything else        →  Go High Level (origin)
```

### Prerequisites
- Cloudflare account with ncflooringliquidators.com added
- Domain DNS set to Cloudflare (proxied, orange cloud)
- Node.js installed locally (for Wrangler CLI)

---

### Step-by-Step Deployment

#### 1. Install Wrangler CLI
```bash
npm install -g wrangler
```

#### 2. Login to Cloudflare
```bash
wrangler login
```
This opens a browser window to authenticate.

#### 3. Enable Proxied DNS
In Cloudflare Dashboard:
- Go to DNS → Records
- Your A/CNAME record for ncflooringliquidators.com must be **Proxied** (orange cloud ON)
- Currently you have "DNS only" (grey cloud) - change this to proxied

**Important**: When you switch to Proxied, your GHL site must still work as the origin. The A record or CNAME should still point to GHL's server.

#### 4. Deploy the Worker
```bash
cd /path/to/this/folder
wrangler deploy
```

#### 5. Add Route in Cloudflare Dashboard
Go to Workers & Pages → your worker → Triggers → Add Route:
- Route: `ncflooringliquidators.com/*`
- Zone: ncflooringliquidators.com

#### 6. Test
- Visit https://ncflooringliquidators.com → should show GHL site
- Visit https://ncflooringliquidators.com/blog/ → should show WordPress blog
- Visit https://ncflooringliquidators.com/area/ → should show WordPress area pages
- Visit https://ncflooringliquidators.com/offer/ → should show WordPress offer pages

---

### WordPress Configuration

In your WordPress install (zyvndv90k2.wpdns.site), update these settings:

**wp-config.php** - Add these lines before "That's all, stop editing!":
```php
/* Reverse Proxy Settings */
define('WP_HOME', 'https://ncflooringliquidators.com');
define('WP_SITEURL', 'https://ncflooringliquidators.com');

/* Trust the proxy headers */
if (isset($_SERVER['HTTP_X_FORWARDED_HOST'])) {
    $_SERVER['HTTP_HOST'] = $_SERVER['HTTP_X_FORWARDED_HOST'];
}
if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    $_SERVER['HTTPS'] = 'on';
}
```

**WordPress Address & Site Address** (Settings → General):
- WordPress Address (URL): https://ncflooringliquidators.com
- Site Address (URL): https://ncflooringliquidators.com

**Permalink Structure** (Settings → Permalinks):
- Make sure /blog/ is the base for posts
- Custom structure: `/blog/%postname%/`

---

### Maintenance Notes

**Adding new WordPress paths:**
Edit `worker.js`, find the `wpPaths` array, and add your new path:
```js
wpPaths: ['/blog', '/area', '/offer', '/new-path'],
```
Then redeploy: `wrangler deploy`

**Cache:**
- HTML pages cache for 5 minutes
- CSS/JS/images cache for 24 hours
- To purge cache: Cloudflare Dashboard → Caching → Purge Everything

**Troubleshooting:**
- If WordPress shows wrong URLs: Check wp-config.php proxy settings
- If redirects loop: Make sure WP_HOME uses https://
- If assets don't load: Check browser console for mixed content warnings
- Worker logs: `wrangler tail` (shows live request logs)
