import { isValidContactEmail, prepareContactMessage } from '../../src/contact/contactMessage';

const MAX_BODY_BYTES = 16 * 1024;

export interface ContactEmailEnv {
  CONTACT_EMAIL?: SendEmail;
  CONTACT_FROM_EMAIL?: string;
  CONTACT_TO_EMAIL?: string;
}

async function readContactJson(request: Request): Promise<{ data: unknown } | { status: 400 | 413 }> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !request.body) {
    return { status: 400 };
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return { status: 413 };

  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_BODY_BYTES - length) {
        void reader.cancel().catch(() => { /* The rejected body is no longer used. */ });
        return { status: 413 };
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length));
    return { data: JSON.parse(json) };
  } catch {
    return { status: 400 };
  } finally {
    reader.releaseLock();
  }
}

export async function handleContact(
  request: Request,
  env: ContactEmailEnv,
  enforceRateLimit: () => Promise<Response | null>,
): Promise<Response> {
  const result = await readContactJson(request);
  if ('status' in result) {
    return Response.json({ error: 'Invalid contact request' }, { status: result.status });
  }
  const { data } = result;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return Response.json({ error: 'Invalid contact request' }, { status: 400 });
  }
  const { name = '', email, message, extra = '' } = data as Record<string, unknown>;
  if (typeof extra === 'string' && extra !== '') return Response.json({ ok: true });
  if (typeof extra !== 'string' || typeof name !== 'string' || typeof email !== 'string' || typeof message !== 'string') {
    return Response.json({ error: 'Invalid contact request' }, { status: 400 });
  }
  const { payload, errors } = prepareContactMessage({ name, email, message });
  if (Object.keys(errors).length) {
    return Response.json({ error: 'Invalid contact request' }, { status: 400 });
  }

  const { CONTACT_EMAIL: binding, CONTACT_FROM_EMAIL: from, CONTACT_TO_EMAIL: to } = env;
  if (typeof binding?.send !== 'function' || !from || !to || !isValidContactEmail(from) || !isValidContactEmail(to)) {
    console.error('[Worker] Contact email binding or address configuration is missing or invalid');
    return Response.json({ error: 'Contact service unavailable' }, { status: 503 });
  }

  const limited = await enforceRateLimit();
  if (limited) return limited;

  // Quote each user-controlled line so it cannot imitate an unquoted boundary.
  const quoted = `Name: ${payload.name}\nEmail: ${payload.email}\n\n${payload.message}`
    .split('\n').map(line => `> ${line}`).join('\n');
  try {
    await binding.send({
      from,
      to,
      replyTo: payload.email,
      subject: 'TankWars contact form',
      text: `--- BEGIN UNTRUSTED USER CONTENT ---\n${quoted}\n--- END UNTRUSTED USER CONTENT ---`,
    });
  } catch {
    console.error('[Worker] Contact email delivery failed');
    return Response.json({ error: 'Contact service unavailable' }, { status: 503 });
  }
  return Response.json({ ok: true });
}
