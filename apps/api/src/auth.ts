import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../../packages/core/src/config.ts';
import { Identity, has } from '../../../packages/core/src/identity.ts';
import { sha256, token } from '../../../packages/core/src/security.ts';
import { insist } from '../../../packages/core/src/errors.ts';

export async function registerAuth(app: FastifyInstance, pool: Pool, config: Config, identity: Identity) {
  const cookieOptions = { secure: config.secureCookies, httpOnly: true, sameSite: 'lax' as const, path: '/' };
  const start = z.object({ purpose: z.enum(['manage', 'download']).default('manage'), returnTo: z.string().max(200).default('/') });
  app.get('/auth/moodle/start', async (request, reply) => {
    const query = start.parse(request.query);
    insist(query.returnTo === '/' || /^\/download\/[0-9a-f-]{36}(\/versions\/[0-9a-f-]{36})?$/.test(query.returnTo), 400, 'INVALID_RETURN', 'Destination non autorisée.');
    const state = token(), browser = token(), verifier = token();
    await pool.query(`INSERT INTO login_transactions(state_hash,browser_hash,verifier,purpose,return_to,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')`, [sha256(state), sha256(browser), verifier, query.purpose, query.returnTo]);
    const url = new URL(`${config.MOODLE_ORIGIN}/local/filesharing/authorize.php`);
    url.search = new URLSearchParams({ client_id: config.MOODLE_CLIENT_ID,
      redirect_uri: `${config.APP_ORIGIN}/auth/moodle/callback`, state,
      code_challenge: Buffer.from(sha256(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256', purpose: query.purpose }).toString();
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return reply.setCookie(`${config.cookieName}_login`, browser, { ...cookieOptions, maxAge: 300 }).redirect(url.href);
  });
  app.get('/auth/moodle/callback', async (request, reply) => {
    const { state, code } = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(request.query);
    const browser = request.cookies[`${config.cookieName}_login`];
    insist(browser, 403, 'INVALID_STATE', 'La connexion n’appartient pas à ce navigateur. Recommencez.');
    const result = await pool.query(`DELETE FROM login_transactions WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *`, [sha256(state), sha256(browser)]);
    insist(result.rowCount, 403, 'INVALID_STATE', 'La connexion a expiré ou a déjà été utilisée.');
    const flow = result.rows[0];
    const actor = await identity.exchange(code, flow.verifier);
    insist(flow.purpose !== 'manage' || has(actor, 'access'), 403, 'FORBIDDEN', 'L’accès à la gestion des ressources n’est pas autorisé.');
    const session = token();
    await pool.query(`INSERT INTO sessions(token_hash,user_id,idle_expires_at,absolute_expires_at)
      VALUES($1,$2,now()+interval '2 hours',now()+interval '12 hours')`, [sha256(session), actor.id]);
    await pool.query("INSERT INTO audit_events(user_id,action,result) VALUES($1,'login','success')", [actor.id]);
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    return reply.clearCookie(`${config.cookieName}_login`, cookieOptions)
      .setCookie(config.cookieName, session, { ...cookieOptions, maxAge: 43200 }).redirect(flow.return_to);
  });
  app.post('/auth/logout', async (request, reply) => {
    await identity.authenticate(request, { mutate: true });
    const cookie = request.cookies[config.cookieName];
    if (cookie) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(cookie)]);
    return reply.clearCookie(config.cookieName, cookieOptions).code(204).send();
  });
  app.get('/api/v1/me', async (request, reply) => {
    const actor = await identity.authenticate(request, { fresh: true, cap: 'access', scope: 'resources:read' });
    reply.header('Cache-Control', 'no-store');
    return { ...actor, csrfToken: actor.kind === 'user' ? identity.csrf(sha256(request.cookies[config.cookieName]!)) : undefined };
  });
}
