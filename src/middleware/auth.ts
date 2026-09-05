/**
 * Inbound authentication - direction: WeAreDA -> Reseller (contract 3.1).
 *
 * WeAreDA attaches the credentials you registered on the integration (or, at
 * credentialScope 'tenant', when you attached this customer), according to
 * the `authType` you chose:
 *
 *   authType   Header WeAreDA sends
 *   ---------  ------------------------------------------------------------
 *   api_key    X-API-Key: <apiKey>                      (default)
 *   bearer     Authorization: Bearer <accessToken|apiKey>
 *   basic      Authorization: Basic base64(clientId:clientSecret)
 *   custom     an arbitrary header map you supplied, e.g. X-Auth-Token: ...
 *
 * This reference defaults to `api_key` and switches with RESELLER_AUTH_MODE.
 *
 * To plug in your own scheme (a JWT, a mutual-TLS header, a signature) replace
 * `verifyCredentials` below - nothing else in the server needs to change.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';

export interface AuthFailure {
  error: 'unauthorized';
  message: string;
}

/** Constant-time comparison, so the server never leaks a credential by timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison to keep the timing profile flat.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function verifyCredentials(request: FastifyRequest, config: AppConfig): boolean {
  const { mode, apiKey, customHeader, basicUser, basicPassword } = config.inbound;
  const headers = request.headers;

  switch (mode) {
    case 'none':
      return true;

    case 'api_key': {
      const provided = firstHeader(headers['x-api-key']);
      return provided !== undefined && safeEqual(provided, apiKey);
    }

    case 'bearer': {
      const authorization = firstHeader(headers.authorization);
      if (!authorization?.toLowerCase().startsWith('bearer ')) return false;
      return safeEqual(authorization.slice(7).trim(), apiKey);
    }

    case 'basic': {
      const authorization = firstHeader(headers.authorization);
      if (!authorization?.toLowerCase().startsWith('basic ')) return false;
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator === -1) return false;
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      return safeEqual(user, basicUser) && safeEqual(password, basicPassword);
    }

    case 'custom': {
      const provided = firstHeader(headers[customHeader.toLowerCase()]);
      return provided !== undefined && safeEqual(provided, apiKey);
    }

    default:
      return false;
  }
}

/**
 * Fastify preHandler. Contract 4.1: `401/403` means "credentials rejected" and
 * is NOT retried by WeAreDA - the integration is flagged for a human instead.
 * So only answer 401 when the credentials really are wrong.
 */
export function requireAuth(config: AppConfig) {
  return async function authPreHandler(request: FastifyRequest, reply: FastifyReply) {
    if (verifyCredentials(request, config)) return;

    const failure: AuthFailure = {
      error: 'unauthorized',
      message: `Invalid or missing credentials for auth mode "${config.inbound.mode}".`,
    };
    await reply.code(401).send(failure);
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Human-readable description of the expected header, for the startup banner. */
export function describeInboundAuth(config: AppConfig): string {
  switch (config.inbound.mode) {
    case 'api_key':
      return 'X-API-Key: <RESELLER_API_KEY>';
    case 'bearer':
      return 'Authorization: Bearer <RESELLER_API_KEY>';
    case 'basic':
      return 'Authorization: Basic base64(RESELLER_BASIC_USER:RESELLER_BASIC_PASSWORD)';
    case 'custom':
      return `${config.inbound.customHeader}: <RESELLER_API_KEY>`;
    case 'none':
      return '(authentication disabled - RESELLER_AUTH_MODE=none)';
    default:
      return 'unknown';
  }
}
