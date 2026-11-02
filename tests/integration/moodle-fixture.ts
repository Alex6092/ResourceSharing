// Double de protocole uniquement : aucun utilisateur ni code de production.
// Il vérifie HMAC, nonce, expiration et PKCE sur de vraies requêtes HTTP.
import Fastify from 'fastify';
import { signature, token, sha256, equals } from '../../packages/core/src/security.ts';
import type { Capability } from '../../packages/core/src/identity.ts';

export async function moodleFixture(secret: string, port = 0) {
  const app = Fastify({ logger: false });
  const people = new Map([
    ['42', { name: 'Enseignante A', active: true, capabilities: ['viewicon', 'access', 'upload'] as Capability[] }],
    ['43', { name: 'Enseignant B', active: true, capabilities: ['viewicon', 'access', 'upload'] as Capability[] }],
    ['44', { name: 'Gestionnaire', active: true, capabilities: ['admin'] as Capability[] }],
    ['45', { name: 'Étudiant', active: true, capabilities: [] as Capability[] }],
  ]);
  const state = { subject: '42', appOrigin: '', expireCodes: false };
  const codes = new Map<string, { subject: string; challenge: string; expires: number }>();
  const nonces = new Set<string>();
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, { raw: String(body), value: JSON.parse(String(body)) }));
  app.get('/local/filesharing/authorize.php', async (request, reply) => {
    const q = request.query as Record<string, string>;
    if (q.redirect_uri !== `${state.appOrigin}/auth/moodle/callback` || q.client_id !== 'mprovifilesharing' || q.code_challenge_method !== 'S256') return reply.code(403).send();
    const person = people.get(state.subject)!;
    if (q.purpose === 'manage' && !person.capabilities.some((cap) => ['access', 'admin'].includes(cap))) return reply.code(403).send();
    const code = token();
    codes.set(sha256(code), { subject: state.subject, challenge: q.code_challenge, expires: Date.now() + (state.expireCodes ? -1 : 60000) });
    const url = new URL(q.redirect_uri);
    url.search = new URLSearchParams({ code, state: q.state }).toString();
    return reply.redirect(url.href);
  });
  app.post('/local/filesharing/service.php', async (request, reply) => {
    const body = request.body as { raw: string; value: Record<string, string> };
    const timestamp = String(request.headers['x-timestamp']), nonce = String(request.headers['x-nonce']);
    const expected = signature(secret, 'POST', '/local/filesharing/service.php', timestamp, nonce, body.raw);
    if (request.headers['x-client-id'] !== 'mprovifilesharing' || request.headers['x-key-id'] !== 'v1'
      || !equals(String(request.headers['x-signature']), expected) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 || nonces.has(nonce)) return reply.code(401).send({ code: 'INVALID_SIGNATURE' });
    nonces.add(nonce);
    let subject = body.value.subject;
    if (body.value.action === 'exchange') {
      const code = codes.get(sha256(body.value.code));
      codes.delete(sha256(body.value.code));
      if (!code) return reply.code(403).send({ code: 'CODE_USED' });
      if (code.expires < Date.now()) return reply.code(403).send({ code: 'CODE_EXPIRED' });
      if (Buffer.from(sha256(body.value.verifier), 'hex').toString('base64url') !== code.challenge) return reply.code(403).send({ code: 'INVALID_PROOF' });
      subject = code.subject;
    }
    const person = people.get(subject)!;
    return { issuer: origin, subject, displayName: person.name, active: person.active, capabilities: person.capabilities };
  });
  const origin = await app.listen({ host: '127.0.0.1', port });
  return { app, state, people, codes, origin };
}
