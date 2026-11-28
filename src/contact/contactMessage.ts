export const CONTACT_NAME_MAX = 100;
export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_MESSAGE_MIN = 10;
export const CONTACT_MESSAGE_MAX = 4000;

export interface ContactMessage {
  name: string;
  email: string;
  message: string;
}

export type ContactField = keyof ContactMessage;
export type ContactErrors = Partial<Record<ContactField, true>>;

const MAILBOX = /^[a-z0-9!#$%&'*+/=?^`{|}~_-]+(?:\.[a-z0-9!#$%&'*+/=?^`{|}~_-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const NON_LF_LINE_BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;
// Keep joiners and emoji tags while removing controls that can reorder quoted text.
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cs}\p{Bidi_Control}]/gu;

function cleanText(value: string): string {
  return value.replace(NON_LF_LINE_BREAKS, '\n')
    .replace(UNSAFE_CHARACTERS, character => character === '\n' || character === '\t' ? character : '')
    .normalize('NFC').trim();
}

export function isValidContactEmail(value: string): boolean {
  const at = value.lastIndexOf('@');
  return value.length <= CONTACT_EMAIL_MAX && at >= 1 && at <= 64 && !/\s/.test(value) && MAILBOX.test(value);
}

export function prepareContactMessage(input: ContactMessage) {
  const name = cleanText(input.name).replace(/[\t\n]+/g, ' ');
  const email = input.email.replace(/^ +| +$/g, '');
  const message = cleanText(input.message);
  const errors: ContactErrors = {};
  if (name.length > CONTACT_NAME_MAX) errors.name = true;
  if (!isValidContactEmail(email)) errors.email = true;
  // Keep the original minimum, measured after stripping format characters and applying NFC.
  const messageLengthWithoutFormatting = message.replace(/\p{Cf}/gu, '').normalize('NFC').trim().length;
  if (messageLengthWithoutFormatting < CONTACT_MESSAGE_MIN || message.length > CONTACT_MESSAGE_MAX) errors.message = true;
  return { payload: { name, email, message }, errors };
}
