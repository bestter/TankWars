// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactScreen } from '../ContactScreen';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => options?.count ? `${key} ${options.count}` : key,
    i18n: { language: 'en' },
  }),
}));

const message = "Étape 1:\n  return '<code>';\nÉtape 2.";

function renderContact() {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  render(<HelmetProvider><ContactScreen onBack={vi.fn()} /></HelmetProvider>);
  const submit = screen.getByRole('button', { name: 'contact_send' });
  const email = screen.getByLabelText<HTMLInputElement>('contact_email');
  const text = screen.getByLabelText<HTMLTextAreaElement>('contact_message');
  const fill = () => {
    fireEvent.change(email, { target: { value: 'guest@example.com' } });
    fireEvent.change(text, { target: { value: message } });
  };
  return { fetchMock, submit, email, text, fill };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ContactScreen', () => {
  it('links submit errors to their fields and focuses the first invalid input', () => {
    const { fetchMock, submit, email, text } = renderContact();
    expect(email.getAttribute('aria-invalid')).toBe('false');
    fireEvent.change(email, { target: { value: 'invalid@-example.com' } });
    fireEvent.change(text, { target: { value: 'short' } });
    fireEvent.click(submit);
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(email.getAttribute('aria-describedby') ?? '')?.textContent).toBe('contact_email_error');
    expect(document.getElementById(text.getAttribute('aria-describedby') ?? '')?.textContent).toBe('contact_message_error');
    expect(document.activeElement).toBe(email);
    expect(text.value).toBe('short');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('simulates by default with a cleaned preview, updates metadata and allows a new message', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { fetchMock, fill, submit } = renderContact();
    await waitFor(() => expect(document.title).toBe('contact_seo_title'));
    fill();
    fireEvent.click(submit);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[TankWars] Contact simulation', { name: '', email: 'guest@example.com', message });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'contact_sent_title' }));
    await waitFor(() => expect(document.title).toBe('contact_sent_seo_title'));
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('contact_simulated_description');
    fireEvent.click(screen.getByRole('button', { name: 'contact_send_another' }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('contact_message').value).toBe('');
  });

  it.each([
    [true, 'http://localhost:8787', 'contact_local_worker_description'],
    [false, 'https://worker.example.com', 'contact_sent_description'],
  ])('posts contact JSON and shows the matching confirmation (DEV=%s)', async (dev, apiBase, description) => {
    vi.stubEnv('DEV', dev);
    vi.stubEnv('VITE_CONTACT_USE_LOCAL_WORKER', 'true');
    vi.stubEnv('VITE_API_BASE', 'https://worker.example.com/');
    const { fetchMock, fill, submit } = renderContact();
    let resolveResponse!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise(resolve => { resolveResponse = resolve; }));
    fill();
    const form = submit.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${apiBase}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'guest@example.com', message, extra: '' }),
      signal: expect.any(AbortSignal),
    });
    expect(submit.matches(':disabled')).toBe(true);
    await act(async () => resolveResponse(Response.json({ ok: true })));
    expect(screen.getByRole('heading', { name: 'contact_sent_title' })).toBeDefined();
    expect(screen.getByText(description)).toBeDefined();
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(description);
  });

  it('posts Unicode text with intact joiners and normalized line breaks', async () => {
    vi.stubEnv('VITE_CONTACT_USE_LOCAL_WORKER', 'true');
    const { fetchMock, email, text, submit } = renderContact();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const name = 'می\u200Cخواهم';
    const emoji = '👩🏽\u200D💻';

    fireEvent.change(screen.getByLabelText('contact_name'), { target: { value: name } });
    fireEvent.change(email, { target: { value: 'guest@example.com' } });
    fireEvent.change(text, { target: { value: emoji + '\u2028// commentaire\u2029const value = 1;' } });
    fireEvent.click(submit);

    await screen.findByRole('heading', { name: 'contact_sent_title' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ name, email: 'guest@example.com', message: emoji + '\n// commentaire\nconst value = 1;', extra: '' }),
    );
  });

  it.each(['headers', 'receipt'] as const)('keeps the draft and allows retry when waiting for %s times out', async phase => {
    vi.stubEnv('VITE_CONTACT_USE_LOCAL_WORKER', 'true');
    vi.useFakeTimers();
    if (phase === 'headers') {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), delay);
        return controller.signal;
      });
    } else {
      vi.stubGlobal('AbortSignal', { timeout: undefined });
    }

    const { fetchMock, fill, submit, email, text } = renderContact();
    const waitForAbort = <T,>(signal: AbortSignal | null | undefined) => new Promise<T>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const response = new Response();
    const readReceipt = vi.spyOn(response, 'json');
    fetchMock.mockImplementationOnce((_url, options) => {
      if (phase === 'headers') return waitForAbort<Response>(options?.signal);
      readReceipt.mockImplementation(() => waitForAbort(options?.signal));
      return Promise.resolve(response);
    });
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));

    fill();
    await act(async () => fireEvent.click(submit));
    expect(submit.matches(':disabled')).toBe(true);
    if (phase === 'receipt') expect(readReceipt).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByRole('alert').textContent).toBe('contact_timeout');
    expect(email.value).toBe('guest@example.com');
    expect(text.value).toBe(message);
    expect(submit.matches(':disabled')).toBe(false);

    await act(async () => fireEvent.click(submit));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'contact_sent_title' })).toBeDefined();
  });

  it.each([
    [429, 'contact_retry_after 60'],
    [400, 'contact_invalid_request'],
    [500, 'contact_service_error'],
    [503, 'contact_service_error'],
    [0, 'contact_network_error'],
  ])('keeps the form filled after a failed request (%s)', async (status, error) => {
    vi.stubEnv('VITE_CONTACT_USE_LOCAL_WORKER', 'true');
    const { fetchMock, fill, submit, email, text } = renderContact();
    if (status) fetchMock.mockResolvedValue(new Response(null, { status, headers: { 'Retry-After': '60' } }));
    else fetchMock.mockRejectedValue(new TypeError('Offline'));
    fill();
    fireEvent.click(submit);
    await screen.findByText(error);
    expect(email.value).toBe('guest@example.com');
    expect(text.value).toBe(message);
    expect(submit.matches(':disabled')).toBe(false);
  });
});
