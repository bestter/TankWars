import { useId, useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SEO } from '../components/SEO';
import { getOnlineApiBase } from '../utils/onlineApi';
import {
  CONTACT_EMAIL_MAX,
  CONTACT_MESSAGE_MAX,
  CONTACT_MESSAGE_MIN,
  CONTACT_NAME_MAX,
  prepareContactMessage,
  type ContactErrors,
  type ContactField,
  type ContactMessage,
} from './contactMessage';

const FIELD_ERRORS = {
  name: 'contact_name_error',
  email: 'contact_email_error',
  message: 'contact_message_error',
} as const;

const CONTACT_TIMEOUT_MS = 15_000;

type Feedback =
  | { key: 'contact_fix_fields' | 'contact_service_error' | 'contact_network_error' | 'contact_timeout' | 'contact_invalid_request' | 'contact_rate_limited' }
  | { key: 'contact_retry_after'; seconds: number };

async function sendContact(payload: ContactMessage & { extra: string }): Promise<Feedback | null> {
  const fallback = typeof AbortSignal.timeout === 'function' ? null : new AbortController();
  const signal = fallback?.signal ?? AbortSignal.timeout(CONTACT_TIMEOUT_MS);
  const timeout = fallback ? setTimeout(() => fallback.abort(), CONTACT_TIMEOUT_MS) : undefined;
  let receivedResponse = false;
  try {
    const response = await fetch(`${getOnlineApiBase()}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    receivedResponse = true;
    if (response.ok) {
      const receipt: unknown = await response.json();
      if (receipt && typeof receipt === 'object' && 'ok' in receipt && receipt.ok === true) {
        return null;
      }
      console.error('[TankWars] Contact submission returned an unexpected receipt');
      return { key: 'contact_service_error' };
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      return Number.isSafeInteger(seconds) && seconds > 0
        ? { key: 'contact_retry_after', seconds }
        : { key: 'contact_rate_limited' };
    }
    console.error('[TankWars] Contact submission failed with status', response.status);
    return { key: response.status === 400 || response.status === 413
      ? 'contact_invalid_request'
      : 'contact_service_error' };
  } catch {
    if (signal.aborted) {
      console.error('[TankWars] Contact submission timed out');
      return { key: 'contact_timeout' };
    }
    console.error('[TankWars] Contact submission failed', receivedResponse ? 'invalid response body' : 'network error');
    return { key: receivedResponse ? 'contact_service_error' : 'contact_network_error' };
  } finally {
    clearTimeout(timeout);
  }
}

type SentDescriptionKey =
  | 'contact_simulated_description'
  | 'contact_local_worker_description'
  | 'contact_sent_description';

function resolveSentDescription(simulated: boolean): SentDescriptionKey {
  if (simulated) return 'contact_simulated_description';
  return import.meta.env.DEV ? 'contact_local_worker_description' : 'contact_sent_description';
}

function resolveVisibleFeedback(feedback: Feedback | null, errors: ContactErrors): Feedback | null {
  if (feedback?.key !== 'contact_fix_fields') return feedback;
  return Object.values(errors).some(Boolean) ? feedback : null;
}

function ContactFeedbackAlert({ feedback }: { feedback: Feedback | null }) {
  const { t } = useTranslation();
  let text: string | null = null;
  if (feedback?.key === 'contact_retry_after') {
    text = t(feedback.key, { count: feedback.seconds });
  } else if (feedback) {
    text = t(feedback.key);
  }
  return <div className="contact-error" role="alert">{text}</div>;
}

export function ContactScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pending = useRef(false);
  const nextFocus = useRef<ContactField | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<ContactErrors>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const simulated = import.meta.env.DEV && import.meta.env.VITE_CONTACT_USE_LOCAL_WORKER !== 'true';
  const sentDescription = resolveSentDescription(simulated);
  const visibleFeedback = resolveVisibleFeedback(feedback, errors);

  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [sent]);

  useLayoutEffect(() => {
    const field = nextFocus.current;
    if (!field) return;
    nextFocus.current = undefined;
    const input = formRef.current?.elements.namedItem(field);
    if (input instanceof HTMLElement) input.focus();
  }, [errors]);

  function fieldProps(field: ContactField) {
    return {
      id: `${id}-${field}`,
      name: field,
      'aria-invalid': errors[field] === true,
      'aria-describedby': errors[field] ? `${id}-${field}-error` : undefined,
      onChange: () => {
        if (errors[field]) setErrors(current => ({ ...current, [field]: undefined }));
      },
    };
  }

  function fieldError(field: ContactField) {
    return errors[field] && <p className="contact-error" id={`${id}-${field}-error`}>{t(FIELD_ERRORS[field])}</p>;
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;

    const data = new FormData(event.currentTarget);
    const prepared = prepareContactMessage({
      name: String(data.get('name') ?? ''),
      email: String(data.get('email') ?? ''),
      message: String(data.get('message') ?? ''),
    });
    const firstError = (Object.keys(prepared.errors) as ContactField[])[0];
    nextFocus.current = firstError;
    setErrors(prepared.errors);
    setFeedback(firstError ? { key: 'contact_fix_fields' } : null);
    if (firstError) return;

    const extra = String(data.get('extra') ?? '');
    const payload = { ...prepared.payload, extra };
    if (simulated) {
      if (!extra) console.info('[TankWars] Contact simulation', prepared.payload);
      setSent(true);
      return;
    }

    pending.current = true;
    setSubmitting(true);
    try {
      const rejected = await sendContact(payload);
      setFeedback(rejected);
      setSent(rejected === null);
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="retro-menu-container">
      <SEO
        titleKey={sent ? 'contact_sent_seo_title' : 'contact_seo_title'}
        descriptionKey={sent ? sentDescription : 'contact_description'}
      />
      <div className="retro-menu-frame contact-frame">
        <div className="retro-menu-inner">
          <h1 className="retro-section" ref={headingRef} tabIndex={-1}>
            {t(sent ? 'contact_sent_title' : 'contact_title')}
          </h1>
          {sent ? (
            <>
              <p>{t(sentDescription)}</p>
              <button className="retro-online-btn" type="button" onClick={() => setSent(false)}>
                {t('contact_send_another')}
              </button>
            </>
          ) : (
            <>
              <p>{t('contact_description')}</p>
              <form className="contact-form" ref={formRef} noValidate onSubmit={submit}>
                <fieldset disabled={submitting}>
                  <label htmlFor={`${id}-name`}>{t('contact_name')}</label>
                  <input {...fieldProps('name')} type="text" autoComplete="name" maxLength={CONTACT_NAME_MAX} />
                  {fieldError('name')}
                  <label htmlFor={`${id}-email`}>{t('contact_email')}</label>
                  <input {...fieldProps('email')} type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={CONTACT_EMAIL_MAX} required />
                  {fieldError('email')}
                  <label htmlFor={`${id}-message`}>{t('contact_message')}</label>
                  <textarea {...fieldProps('message')} rows={6} minLength={CONTACT_MESSAGE_MIN} maxLength={CONTACT_MESSAGE_MAX} required />
                  {fieldError('message')}
                  <input hidden aria-hidden="true" tabIndex={-1} type="text" autoComplete="off" name="extra" />
                  <button className="retro-online-btn" type="submit">
                    {t(submitting ? 'contact_sending' : 'contact_send')}
                  </button>
                </fieldset>
                <ContactFeedbackAlert feedback={visibleFeedback} />
                <div className="visually-hidden" role="status">
                  {submitting ? t('contact_sending') : null}
                </div>
              </form>
            </>
          )}
          <button className="retro-online-btn contact-back" type="button" onClick={onBack}>
            {t('contact_back')}
          </button>
        </div>
      </div>
    </div>
  );
}
