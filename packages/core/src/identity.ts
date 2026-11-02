import { z } from 'zod';
import { randomUUID, createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { sha256, signRequest, equals } from './security.ts';
import { insist, HttpError } from './errors.ts';

export const capability = z.enum(['viewicon', 'access', 'upload', 'manageothers', 'admin']);
export type Capability = z.infer<typeof capability>;
export type UserActor = { kind: 'user'; id: string; subject: string; name: string; capabilities: Capability[] };
export type ServiceActor = { kind: 'service'; id: string; name: string; scopes: string[] };
export type Actor = UserActor | ServiceActor;
export const has = (actor: Actor, cap: Capability) => actor.kind === 'user'
  && (actor.capabilities.includes(cap) || actor.capabilities.includes('admin'));

const identitySchema = z.object({
  issuer: z.string(), subject: z.string().regex(/^[1-9]\d{0,14}$/),
  displayName: z.string().max(255), active: z.boolean(), capabilities: z.array(capability),
});
export type MoodleIdentity = z.infer<typeof identitySchema>;

export class Identity {
  config: Config;
  pool: Pool;
  constructor(config: Config, pool: Pool) { this.config = config; this.pool = pool; }
  async call(body: Record<string, unknown>): Promise<unknown> {
    const path = '/local/filesharing/service.php';
    const raw = JSON.stringify(body);
    try {
      const response = await fetch(`${this.config.MOODLE_ORIGIN}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: signRequest(this.config.MOODLE_SHARED_SECRET, this.config.MOODLE_CLIENT_ID, this.config.MOODLE_KEY_ID, path, raw), body: raw,
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw new Error('Réponse vide.');
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 65536) throw new Error('Réponse Moodle trop volumineuse.');
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        if (body.action === 'exchange' && ['CODE_EXPIRED', 'CODE_USED', 'INVALID_PROOF', 'SSO_DENIED'].includes(value.code)) {
          throw new HttpError(403, 'SSO_DENIED', 'Le lien de connexion a expiré ou a déjà été utilisé. Recommencez depuis Moodle.');
        }
        throw new Error('Moodle a refusé l’échange.');
      }
      return value;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'MOODLE_UNAVAILABLE', 'La vérification Moodle est temporairement indisponible. Réessayez.');
    }
  }
  async accept(raw: unknown): Promise<UserActor> {
    const parsed = identitySchema.safeParse(raw);
    insist(parsed.success && parsed.data.issuer === this.config.MOODLE_ORIGIN, 503, 'INVALID_MOODLE_RESPONSE', 'Réponse Moodle invalide.');
    const identity = parsed.data;
    const result = await this.pool.query(`INSERT INTO users(id,moodle_issuer,moodle_subject,display_name,active,capabilities)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(moodle_issuer,moodle_subject) DO UPDATE SET
      display_name=excluded.display_name,active=excluded.active,capabilities=excluded.capabilities,checked_at=now() RETURNING id`,
    [randomUUID(), identity.issuer, identity.subject, identity.displayName, identity.active, identity.active ? identity.capabilities : []]);
    const id = result.rows[0].id;
    if (!identity.active) {
      await this.pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'Ce compte Moodle n’est plus autorisé.');
    }
    return { kind: 'user', id, subject: identity.subject, name: identity.displayName, capabilities: identity.capabilities };
  }
  async subject(subject: string) { return this.accept(await this.call({ action: 'status', subject })); }
  async exchange(code: string, verifier: string) {
    return this.accept(await this.call({ action: 'exchange', code, verifier,
      redirectUri: `${this.config.APP_ORIGIN}/auth/moodle/callback`, clientId: this.config.MOODLE_CLIENT_ID }));
  }
  csrf(sessionHash: string) {
    return createHmac('sha256', Buffer.from(this.config.SESSION_SECRET, 'hex')).update(`csrf:${sessionHash}`).digest('base64url');
  }
  async authenticate(request: FastifyRequest, { fresh = false, mutate = false, cap, scope }: {
    fresh?: boolean; mutate?: boolean; cap?: Capability; scope?: string;
  } = {}): Promise<Actor> {
    const authorization = request.headers.authorization;
    let actor: Actor;
    if (authorization) {
      insist(/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization), 401, 'UNAUTHORIZED', 'Jeton API invalide.');
      const result = await this.pool.query(`SELECT * FROM service_accounts WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, [sha256(authorization.slice(7))]);
      insist(result.rowCount, 401, 'UNAUTHORIZED', 'Jeton API expiré ou révoqué.');
      const service = result.rows[0];
      insist(!mutate && scope && service.scopes.includes(scope), 403, 'FORBIDDEN', 'Ce compte technique ne possède pas la portée nécessaire.');
      actor = { kind: 'service', id: service.id, name: service.name, scopes: service.scopes };
    } else {
      const cookie = request.cookies[this.config.cookieName];
      insist(cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie), 401, 'UNAUTHORIZED', 'Connexion Moodle requise.');
      const hash = sha256(cookie);
      const result = await this.pool.query(`SELECT u.*,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.idle_expires_at>now() AND s.absolute_expires_at>now() AND u.active`, [hash]);
      insist(result.rowCount, 401, 'UNAUTHORIZED', 'La session a expiré. Connectez-vous via Moodle.');
      const user = result.rows[0];
      insist(user.moodle_issuer === this.config.MOODLE_ORIGIN, 401, 'UNAUTHORIZED', 'Session Moodle invalide.');
      if (mutate) {
        const csrf = request.headers['x-csrf-token'];
        insist(request.headers.origin === this.config.APP_ORIGIN && typeof csrf === 'string' && equals(this.csrf(hash), csrf),
          403, 'CSRF', 'La protection de la session a expiré. Rechargez la page.');
      }
      actor = fresh || mutate || Date.now() - new Date(user.checked_at).getTime() >= 300000
        ? await this.subject(String(user.moodle_subject))
        : { kind: 'user', id: user.id, subject: String(user.moodle_subject), name: user.display_name, capabilities: user.capabilities };
      await this.pool.query("UPDATE sessions SET idle_expires_at=least(absolute_expires_at,now()+interval '2 hours') WHERE token_hash=$1", [hash]);
    }
    if (cap) insist(has(actor, cap) || actor.kind === 'service', 403, 'FORBIDDEN', 'Cette action nécessite des droits supplémentaires.');
    return actor;
  }
}
