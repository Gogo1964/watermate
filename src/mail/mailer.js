import nodemailer from 'nodemailer';

/**
 * SMTP delivery.
 *
 * Credentials arrive exclusively from configuration (environment / `.env`);
 * nothing is ever hard-coded. With `MAIL_DRY_RUN=true` no transport is created
 * at all and mails are logged instead — useful on a first run or in tests.
 */
export function createMailer({ config, logger, transport }) {
  const { mail } = config;
  const log = logger.child({ component: 'mailer' });
  const sent = [];

  const activeTransport = transport ?? (mail.dryRun ? null : createTransport(mail));

  async function send({ to, subject, html, text, type = 'mail' }) {
    const recipients = Array.isArray(to) ? to : [to];
    const cleaned = recipients.filter(Boolean);
    // Without a transport there is nothing to address, so a dry run is still
    // useful with no recipients at all — that is the zero-config first run.
    if (cleaned.length === 0 && !mail.dryRun) {
      log.warn('Skipping mail, no recipients configured', { type, subject });
      return { skipped: true, reason: 'no_recipients' };
    }

    const message = {
      from: mail.from,
      to: cleaned.join(', ') || '(dry run — no recipient configured)',
      subject: mail.subjectPrefix ? `${mail.subjectPrefix} ${subject}` : subject,
      text,
      html,
    };

    if (!activeTransport) {
      log.info('DRY RUN — mail not sent', { type, to: message.to, subject: message.subject });
      // Print the body so a first run shows exactly what would have gone out.
      process.stdout.write(`\n${'-'.repeat(72)}\nSubject: ${message.subject}\nTo: ${message.to}\n\n${text}\n${'-'.repeat(72)}\n\n`);
      sent.push(message);
      return { dryRun: true, message };
    }

    const info = await activeTransport.sendMail(message);
    sent.push(message);
    log.info('Mail sent', {
      type,
      to: message.to,
      subject: message.subject,
      messageId: info.messageId,
      response: info.response,
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  }

  async function verify() {
    if (!activeTransport?.verify) {
      log.info('SMTP verification skipped (dry-run or custom transport)');
      return true;
    }
    await activeTransport.verify();
    log.info('SMTP connection verified', { host: mail.smtp.host, port: mail.smtp.port });
    return true;
  }

  function close() {
    activeTransport?.close?.();
  }

  return { send, verify, close, sentMessages: sent };
}

export function createTransport(mail) {
  const { smtp } = mail;
  const options = {
    host: smtp.host,
    port: smtp.port,
    // `secure` means "TLS from the first byte" (usually port 465). STARTTLS
    // upgrades a plain connection, which is what port 587 expects.
    secure: smtp.tls === 'implicit',
    requireTLS: smtp.tls === 'starttls',
    ignoreTLS: smtp.tls === 'none',
    tls: { rejectUnauthorized: smtp.rejectUnauthorized },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    pool: false,
  };
  if (smtp.name) options.name = smtp.name;
  if (smtp.user) options.auth = { user: smtp.user, pass: smtp.password ?? '' };
  return nodemailer.createTransport(options);
}

/** In-memory transport used by the test suite. */
export function createMemoryTransport() {
  const messages = [];
  return {
    messages,
    async sendMail(message) {
      messages.push(message);
      return { messageId: `test-${messages.length}`, accepted: [message.to], rejected: [], response: '250 OK' };
    },
    async verify() {
      return true;
    },
    close() {},
  };
}
