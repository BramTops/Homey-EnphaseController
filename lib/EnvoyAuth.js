'use strict';

const https = require('https');
const fetch = require('node-fetch');

// Custom agent to bypass self-signed certificate validation on Envoy.
// Configured with keepAlive to reuse TCP/TLS sockets and prevent socket exhaustion.
// Includes a 4-second idle socket timeout so connections are recycled immediately after polls.
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 1000,
  timeout: 4000,
});

class EnvoyAuth {
  /**
   * Envoy Authentication Manager
   * @param {Object} opts
   * @param {Function} opts.log - Logging function
   * @param {string} opts.userEmail - Enlighten Email
   * @param {string} opts.password - Enlighten Password
   * @param {string} opts.envoySerial - Envoy Gateway Serial Number
   * @param {string} opts.envoyIp - Local Envoy IP Address
   * @param {string} [opts.initialToken] - Previously stored JWT token
   * @param {Function} [opts.onTokenUpdated] - Callback when a new JWT is fetched
   */
  constructor({
    log, userEmail, password, envoySerial, envoyIp, initialToken, onTokenUpdated,
  }) {
    // eslint-disable-next-line no-console
    this.log = log || console.log;
    this.userEmail = userEmail;
    this.password = password;
    this.envoySerial = envoySerial;
    this.envoyIp = envoyIp;
    this.token = initialToken || null;
    this.onTokenUpdated = onTokenUpdated || (() => {});
    this.sessionCookie = null; // Cache local session cookie to prevent eviction tug-of-war
  }

  /**
   * Helper to format the IP/host for use in a URL.
   * Encloses IPv6 addresses in square brackets if not already present.
   * @returns {string} Formatted host
   */
  getFormattedHost() {
    if (this.envoyIp && this.envoyIp.includes(':') && !this.envoyIp.startsWith('[') && !this.envoyIp.endsWith(']')) {
      return `[${this.envoyIp}]`;
    }
    return this.envoyIp;
  }

  /**
   * Validate the currently active token or fetch a new one if expired/missing.
   * @returns {Promise<string>} Valid token
   */
  async getToken() {
    if (this.token && this.validateToken(this.token)) {
      this.log('Existing Enphase JWT token is valid.');
      return this.token;
    }

    this.log('Enphase JWT token is missing or expired. Fetching a new one...');
    const newToken = await this.fetchNewToken();
    this.token = newToken;

    // Notify listener (device) to persist the new token
    try {
      await this.onTokenUpdated(newToken);
    } catch (err) {
      this.log('Error triggering token updated callback:', err.message);
    }

    return newToken;
  }

  /**
   * Locally decodes the JWT and validates the expiration date.
   * @param {string} token - The JWT token to validate
   * @returns {boolean} True if token is valid
   */
  validateToken(token) {
    if (!token) return false;

    try {
      const parts = token.split('.');
      if (parts.length < 2) return false;

      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = Buffer.from(base64, 'base64').toString();
      const payload = JSON.parse(jsonPayload);

      const currentTime = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < currentTime) {
        this.log(`Token expired at ${new Date(payload.exp * 1000).toISOString()}`);
        return false;
      }

      this.log('Token decoded and confirmed valid.');
      return true;
    } catch (err) {
      this.log('Token decoding failed. Token may be malformed:', err.message);
      return false;
    }
  }

  /**
   * Decodes a JWT token payload and checks its role and expiration.
   * @param {string} token - The JWT token
   * @returns {Object} Decoded properties: { token, isMaintainer, exp }
   */
  evaluateTokenRole(token) {
    if (!token) return { token: null, isMaintainer: false, exp: 0 };

    try {
      const parts = token.split('.');
      if (parts.length < 2) return { token, isMaintainer: false, exp: 0 };

      const base64Url = parts[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = Buffer.from(base64, 'base64').toString();
      const payload = JSON.parse(jsonPayload);

      const { enphaseUser } = payload;
      const roles = payload.roles || [];
      const isMaintainer = enphaseUser === 'installer'
                     || enphaseUser === 'maintainer'
                     || roles.includes('installer')
                     || roles.includes('maintainer');

      return {
        token,
        isMaintainer,
        exp: payload.exp || 0,
      };
    } catch (err) {
      this.log('Failed to parse token role during evaluation:', err.message);
      return { token, isMaintainer: false, exp: 0 };
    }
  }

  /**
   * Fetch a brand new JWT token from Enphase Cloud JSON API.
   * @returns {Promise<string>} Newly generated JWT token
   */
  async fetchNewTokenViaApi() {
    this.log('Starting API token retrieval path from Enphase Cloud...');

    const loginParams = new URLSearchParams();
    loginParams.append('user[email]', this.userEmail);
    loginParams.append('user[password]', this.password);

    this.log('Logging into Enlighten API...');
    const loginRes = await fetch('https://enlighten.enphaseenergy.com/login/login.json', {
      method: 'POST',
      body: loginParams,
      timeout: 15000,
    });

    if (!loginRes.ok) {
      throw new Error(`Enphase API login failed. Status: ${loginRes.status}`);
    }

    const loginData = await loginRes.json();
    if (!loginData.session_id) {
      throw new Error('Enphase login did not return a session_id. Please verify email and password.');
    }
    this.log('API Login successful, Session ID obtained.');

    this.log(`Requesting Entrez API token for gateway: ${this.envoySerial}...`);
    const tokenRes = await fetch('https://entrez.enphaseenergy.com/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: loginData.session_id,
        serial_num: this.envoySerial,
        username: this.userEmail,
      }),
      timeout: 15000,
    });

    if (!tokenRes.ok) {
      throw new Error(`Entrez API Token retrieval failed. Status: ${tokenRes.status}`);
    }

    const token = await tokenRes.text();
    if (!token || token.trim() === '' || token.includes('Error')) {
      throw new Error(`Entrez API token response is invalid: ${token}`);
    }

    this.log('New token successfully retrieved from Enphase Cloud API.');
    return token.trim();
  }

  /**
   * Fetch a brand new JWT token from the Enphase Entrez interactive web portal (HTML scraping flow).
   * Automatically discovers the Site Name associated with the Envoy serial number.
   * @returns {Promise<string>} Newly generated JWT token
   */
  async fetchNewTokenViaPortal() {
    this.log('Starting portal scraping token retrieval from Enphase Entrez portal...');

    // 1. Load login main page to get initial session cookie and CSRF token
    this.log('Loading Entrez login main page...');
    const mainPageRes = await fetch('https://entrez.enphaseenergy.com/login_main_page', {
      method: 'GET',
      headers: {
        'User-Agent': 'Homey-EnphaseController',
      },
      timeout: 15000,
    });

    if (!mainPageRes.ok) {
      throw new Error(`Failed to load Entrez login main page. Status: ${mainPageRes.status}`);
    }

    const mainPageHtml = await mainPageRes.text();
    const initialCookies = mainPageRes.headers.raw()['set-cookie'] || [];
    const mainPageCsrfMatch = mainPageHtml.match(/name="_csrf"\s+value="([^"]+)"/i);
    const loginCsrfToken = mainPageCsrfMatch ? mainPageCsrfMatch[1] : null;
    if (!loginCsrfToken) {
      throw new Error('Failed to parse CSRF token from Enphase Entrez login main page.');
    }

    // Parse and track all cookies
    const allCookies = new Map();
    initialCookies.forEach((c) => {
      const parts = c.split(';')[0].split('=');
      if (parts.length >= 2) {
        allCookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
      }
    });

    const getCookieHeader = () => Array.from(allCookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

    // 2. Establish session by posting credentials to /login
    const loginParams = new URLSearchParams();
    loginParams.append('username', this.userEmail);
    loginParams.append('password', this.password);
    loginParams.append('_csrf', loginCsrfToken);
    loginParams.append('authFlow', 'entrezSession');

    this.log('Logging into Entrez portal...');
    const loginRes = await fetch('https://entrez.enphaseenergy.com/login', {
      method: 'POST',
      headers: {
        Cookie: getCookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Homey-EnphaseController',
        Referer: 'https://entrez.enphaseenergy.com/login_main_page',
      },
      body: loginParams,
      redirect: 'manual', // Intercept redirect to capture set-cookie headers
      timeout: 15000,
    });

    // Capture and merge cookies from the POST response
    const postCookies = loginRes.headers.raw()['set-cookie'] || [];
    postCookies.forEach((c) => {
      const parts = c.split(';')[0].split('=');
      if (parts.length >= 2) {
        allCookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
      }
    });

    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
      throw new Error('Entrez portal login failed: No session cookies returned. Please verify credentials.');
    }

    // 3. Request the Entrez token generation form page to fetch CSRF token and Site mappings
    this.log('Loading Entrez token form page...');
    const formRes = await fetch('https://entrez.enphaseenergy.com/entrez_tokens', {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        'User-Agent': 'Homey-EnphaseController',
        Referer: 'https://entrez.enphaseenergy.com/login_main_page',
      },
      timeout: 15000,
    });

    if (!formRes.ok) {
      throw new Error(`Failed to load Entrez token form page. Status: ${formRes.status}`);
    }

    const html = await formRes.text();

    // 4. Extract CSRF Token
    // Matches: <input type="hidden" name="_csrf" value="CSRF_TOKEN_HERE" />
    const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/i);
    const csrfToken = csrfMatch ? csrfMatch[1] : null;
    if (!csrfToken) {
      throw new Error('Failed to parse CSRF token from Enphase Entrez portal page.');
    }
    this.log('Successfully retrieved CSRF token.');

    // 5. Auto-discover Site Name associated with the Envoy Serial Number
    // Look for options in the HTML like: <option value="My Site Name">1223456789012 (My Site Name)</option>
    this.log(`Auto-detecting Site Name for Envoy Serial Number ${this.envoySerial}...`);
    const siteRegex = new RegExp(`value="([^"]+)"[^>]*>[^<]*${this.envoySerial}`, 'i');
    const siteMatch = html.match(siteRegex);
    let siteName = siteMatch ? siteMatch[1] : null;

    if (siteName) {
      this.log(`Auto-discovered Site Name linked to serial: "${siteName}"`);
    } else {
      // Fallback: Check if there's any single default option or pre-filled "Site" input field in the page
      const defaultSiteMatch = html.match(/name="Site"\s+value="([^"]+)"/i);
      if (defaultSiteMatch) {
        siteName = defaultSiteMatch[1];
        this.log(`Using default pre-filled Site Name from form: "${siteName}"`);
      } else {
        // Ultimate fallback: Try the serial number itself or empty string
        siteName = this.envoySerial;
        this.log(`Site Name not found in option dropdown, falling back to Envoy Serial: "${siteName}"`);
      }
    }

    // 6. Submit the token generation form
    this.log('Submitting Entrez token generation request...');
    const tokenParams = new URLSearchParams();
    tokenParams.append('serialNum', this.envoySerial);
    tokenParams.append('Site', siteName);
    tokenParams.append('_csrf', csrfToken);

    const tokenRes = await fetch('https://entrez.enphaseenergy.com/entrez_tokens', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Homey-EnphaseController',
        Referer: 'https://entrez.enphaseenergy.com/entrez_tokens',
      },
      body: tokenParams,
      timeout: 15000,
    });

    if (!tokenRes.ok) {
      throw new Error(`Token generation via portal failed. Status: ${tokenRes.status}`);
    }

    const responseHtml = await tokenRes.text();

    // 6. Extract the JWT from the <textarea id="JWTToken"> element
    const tokenMatch = responseHtml.match(/id="JWTToken"[^>]*>([^<]+)<\/textarea>/i);
    const token = tokenMatch ? tokenMatch[1].trim() : null;

    if (!token || token.includes('Error')) {
      throw new Error(`Entrez portal returned an invalid token response: ${token || 'Empty'}`);
    }

    this.log('New token successfully retrieved from Enphase Entrez Portal.');
    return token;
  }

  /**
   * Fetch a brand new JWT token from Enphase Cloud.
   * Orchestrates both the native API flow and the Web Portal scraping flow,
   * automatically selecting the token with the highest privilege tier.
   * @returns {Promise<string>} Best available JWT token
   */
  async fetchNewToken() {
    this.log('Orchestrating dual-path token retrieval from Enphase Cloud...');

    // Execute both in parallel with silent catch triggers
    const [apiResult, portalResult] = await Promise.all([
      this.fetchNewTokenViaApi().catch((err) => {
        this.log(`API token retrieval path failed: ${err.message}`);
        return null;
      }),
      this.fetchNewTokenViaPortal().catch((err) => {
        this.log(`Portal scraping token retrieval path failed: ${err.message}`);
        return null;
      }),
    ]);

    if (!apiResult && !portalResult) {
      throw new Error('Both Enphase Cloud token acquisition paths failed. Please verify credentials and network connection.');
    }

    const decodedApi = this.evaluateTokenRole(apiResult);
    const decodedPortal = this.evaluateTokenRole(portalResult);

    this.log(`Token Evaluation - API Path: [Is Maintainer: ${decodedApi.isMaintainer}], Portal Path: [Is Maintainer: ${decodedPortal.isMaintainer}]`);

    // Upgrade logic: Prefer Portal token if it yields higher access
    if (decodedPortal.token && decodedPortal.isMaintainer && !decodedApi.isMaintainer) {
      this.log('Success: Portal token upgraded access level to Maintainer/Installer. Selecting Portal Token.');
      return decodedPortal.token;
    }

    // Default to API token if roles are equivalent, or whichever succeeded
    if (decodedApi.token) {
      this.log('Selecting API Token.');
      return decodedApi.token;
    }

    this.log('Selecting Portal Token as API token was unavailable.');
    return decodedPortal.token;
  }

  /**
   * Authenticate JWT with local Envoy and retrieve a session cookie.
   * @param {string} token - The Bearer token
   * @param {boolean} [forceRefresh=false] - Force renewal of the cookie
   * @returns {Promise<string>} Session cookie string
   */
  async getSessionCookie(token, forceRefresh = false) {
    if (this.sessionCookie && !forceRefresh) {
      this.log('Using cached local session cookie.');
      return this.sessionCookie;
    }

    const host = this.getFormattedHost();
    const authUrl = `https://${host}/auth/check_jwt`;
    this.log(`Validating JWT with local Envoy at ${host}...`);

    const authResponse = await fetch(authUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      agent: httpsAgent,
      timeout: 15000, // 15s timeout
    });

    if (!authResponse.ok) {
      throw new Error(`Local auth check failed. Status: ${authResponse.status}`);
    }

    const cookie = authResponse.headers.get('set-cookie');
    if (!cookie) {
      throw new Error('Local auth succeeded but no session cookie was returned.');
    }

    this.log('Local auth successful. Session cookie received and cached.');
    this.sessionCookie = cookie;
    return cookie;
  }
}

EnvoyAuth.httpsAgent = httpsAgent;

module.exports = EnvoyAuth;
