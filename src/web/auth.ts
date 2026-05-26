import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger.js';

const COOKIE_NAME = 'discobot_admin';
const DEFAULT_TTL_HOURS = 12;
const MAX_TTL_HOURS = 24 * 14;

type CookieOptions = {
  maxAgeSeconds?: number;
  clear?: boolean;
  secure?: boolean;
};

let warnedAuthDisabled = false;
let warnedMissingSecret = false;

function getAdminToken() {
  return process.env.ADMIN_TOKEN?.trim() || '';
}

function getSessionSecret() {
  const explicitSecret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (explicitSecret) return explicitSecret;

  const adminToken = getAdminToken();
  if (adminToken && !warnedMissingSecret) {
    warnedMissingSecret = true;
    logger.warn('ADMIN_SESSION_SECRET não definido; usando ADMIN_TOKEN como segredo de sessão.');
  }

  return adminToken;
}

function getTtlSeconds() {
  const hours = Number(process.env.ADMIN_SESSION_TTL_HOURS || DEFAULT_TTL_HOURS);
  if (hours === 0) return 0;

  const safeHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_TTL_HOURS) : DEFAULT_TTL_HOURS;
  return Math.floor(safeHours * 60 * 60);
}

export function isAuthEnabled() {
  const enabled = Boolean(getAdminToken());

  if (!enabled && !warnedAuthDisabled) {
    warnedAuthDisabled = true;
    logger.warn('ADMIN_TOKEN não definido; painel web iniciado sem autenticação.');
  }

  return enabled;
}

function parseCookies(header?: string) {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;

    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }

  return cookies;
}

function signSession(issuedAt: number) {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(`admin:${issuedAt}`)
    .digest('base64url');
}

function timingSafeEqualString(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function isHttpsRequest(req: IncomingMessage & { secure?: boolean }) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function serializeCookie(value: string, options: CookieOptions = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (options.clear) {
    parts.push('Max-Age=0');
  } else if (options.maxAgeSeconds) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }

  if (options.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function createAdminSessionCookie(req: Request) {
  const issuedAt = Date.now();
  const ttlSeconds = getTtlSeconds();
  const value = `${issuedAt}.${signSession(issuedAt)}`;
  return serializeCookie(value, {
    maxAgeSeconds: ttlSeconds > 0 ? ttlSeconds : undefined,
    secure: isHttpsRequest(req) || process.env.ADMIN_COOKIE_SECURE === 'true',
  });
}

export function clearAdminSessionCookie(req: Request) {
  return serializeCookie('', {
    clear: true,
    secure: isHttpsRequest(req) || process.env.ADMIN_COOKIE_SECURE === 'true',
  });
}

export function verifyAdminToken(candidate: unknown) {
  const adminToken = getAdminToken();
  if (!adminToken || typeof candidate !== 'string') return false;
  return timingSafeEqualString(candidate, adminToken);
}

export function isPanelRequestAuthenticated(req: IncomingMessage) {
  if (!isAuthEnabled()) return true;

  const cookie = parseCookies(req.headers.cookie).get(COOKIE_NAME);
  if (!cookie) return false;

  const [issuedAtRaw, signature] = cookie.split('.');
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || !signature) return false;

  const ttlSeconds = getTtlSeconds();
  if (ttlSeconds > 0) {
    const expiresAt = issuedAt + ttlSeconds * 1000;
    if (Date.now() > expiresAt) return false;
  }

  return timingSafeEqualString(signature, signSession(issuedAt));
}

function wantsJson(req: Request) {
  return req.xhr
    || req.path.startsWith('/model/')
    || req.path.startsWith('/tool/')
    || req.path.startsWith('/reminder/')
    || req.accepts(['html', 'json']) === 'json';
}

export function requirePanelAuth(req: Request, res: Response, next: NextFunction) {
  if (isPanelRequestAuthenticated(req)) {
    next();
    return;
  }

  if (wantsJson(req)) {
    res.status(401).json({ success: false, error: 'Não autenticado.' });
    return;
  }

  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
}
