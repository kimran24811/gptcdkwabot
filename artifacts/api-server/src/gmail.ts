import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./lib/logger.js";

export interface VerifyResult {
  verified: boolean;
  amount?: string;
  messageId?: string;
}

function amountsMatch(emailAmount: string, expected: string): boolean {
  const a = Math.round(parseFloat(emailAmount.replace(/,/g, "")));
  const b = Math.round(parseFloat(expected.replace(/,/g, "")));
  return !isNaN(a) && !isNaN(b) && a === b;
}

function titleMatches(bodyLower: string, title: string): boolean {
  const clean = title.trim().toLowerCase();
  if (!clean) return false;
  if (bodyLower.includes(clean)) return true;
  const words = clean.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return false;
  const matched = words.filter((w) => bodyLower.includes(w));
  return matched.length / words.length >= 0.6;
}

function isNayaPayEmail(fromText: string, fromAddr: string, subject: string, body: string): boolean {
  if (/nayapay/i.test(fromAddr)) return true;
  if (/nayapay/i.test(fromText)) return true;
  if (/nayapay/i.test(subject)) return true;
  if (/nayapay/i.test(body)) return true;
  if (/payment.*received|money.*received|transfer.*received|amount.*received/i.test(subject)) return true;
  if (/payment.*received|money.*received|transfer.*received|amount.*received/i.test(body)) return true;
  return false;
}

function extractAmount(bodyText: string): string {
  const m =
    bodyText.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)/i) ??
    bodyText.match(/PKR\s*:?\s*([\d,]+(?:\.\d+)?)/i) ??
    bodyText.match(/([\d,]+(?:\.\d+)?)\s*PKR/i) ??
    bodyText.match(/([\d,]+(?:\.\d+)?)\s*Rs/i);
  return m?.[1]?.replace(/,/g, "") ?? "";
}

async function checkEmails(
  client: ImapFlow,
  mailbox: string,
  uids: number[],
  amount: string,
  acctTitle: string
): Promise<VerifyResult> {
  const titleLower = acctTitle.trim().toLowerCase();

  // Check from most recent to oldest, cap at 50 emails to avoid slow fetches
  const toCheck = [...uids].reverse().slice(0, 50);

  for (const uid of toCheck) {
    const msg = await client.fetchOne(String(uid), { source: true }).catch(() => null);
    if (!msg) continue;
    const source = (msg as unknown as { source?: Buffer }).source;
    if (!source) continue;

    const parsed = await simpleParser(source).catch(() => null);
    if (!parsed) continue;

    const fromText = parsed.from?.text ?? "";
    const fromAddr = parsed.from?.value?.[0]?.address ?? "";
    const subject = parsed.subject ?? "";
    const bodyText = (parsed.text ?? "") + (typeof parsed.html === "string" ? parsed.html : "");
    const bodyLower = bodyText.toLowerCase();

    if (!isNayaPayEmail(fromText, fromAddr, subject, bodyText)) continue;

    const emailAmount = extractAmount(bodyText);
    const amtMatches = amountsMatch(emailAmount, amount);
    const ttlMatches = titleMatches(bodyLower, titleLower);

    logger.info(
      { uid, mailbox, emailAmount, expectedAmount: amount, amtMatches, ttlMatches, fromAddr, acctTitle },
      "[gmail] Email checked"
    );

    if (amtMatches && ttlMatches) {
      const messageId = (parsed.messageId as string | undefined) ?? `${mailbox}:${uid}`;
      return { verified: true, amount: emailAmount || amount, messageId };
    }
  }

  return { verified: false };
}

async function searchMailbox(
  client: ImapFlow,
  mailbox: string,
  amount: string,
  acctTitle: string,
  since: Date
): Promise<VerifyResult> {
  let lock;
  try {
    lock = await client.getMailboxLock(mailbox);
  } catch {
    // Mailbox doesn't exist in this Gmail account — skip silently
    return { verified: false };
  }

  try {
    const toArray = (r: number[] | false | null | undefined): number[] =>
      Array.isArray(r) ? r : [];

    // Pass 1: IMAP body search for the amount string (fast — server-side filter)
    const filteredRaw = await client.search({ since, body: amount }).catch(() => null);
    const filteredUids = toArray(filteredRaw as number[] | false | null);

    if (filteredUids.length > 0) {
      logger.info({ mailbox, count: filteredUids.length, amount }, "[gmail] Body-search pass found candidates");
      const result = await checkEmails(client, mailbox, filteredUids, amount, acctTitle);
      if (result.verified) return result;
    }

    // Pass 2: If body search found nothing, fetch all recent emails (catches emails with amount in image / different format)
    const allRaw = await client.search({ since }).catch(() => null);
    const allUids = toArray(allRaw as number[] | false | null);

    if (allUids.length === 0) {
      logger.warn({ mailbox, amount, acctTitle }, "[gmail] No emails at all in time window");
      return { verified: false };
    }

    logger.info({ mailbox, total: allUids.length, amount }, "[gmail] Falling back to full scan");
    return await checkEmails(client, mailbox, allUids, amount, acctTitle);
  } finally {
    lock.release();
  }
}

export async function verifyPaymentByEmail(
  acctTitle: string,
  amount: string,
  credentials?: { user: string; pass: string }
): Promise<VerifyResult> {
  const user = credentials?.user || process.env["GMAIL_USER"] || "";
  const pass = credentials?.pass || process.env["GMAIL_APP_PASSWORD"] || "";

  if (!user || !pass) {
    logger.warn("[gmail] Gmail credentials not configured — set gmail_user and gmail_password in Settings");
    return { verified: false };
  }

  // Search window: 8 hours to catch slow NayaPay delivery
  const since = new Date();
  since.setHours(since.getHours() - 8);

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();

    // Try INBOX first
    let result = await searchMailbox(client, "INBOX", amount, acctTitle, since);
    if (result.verified) return result;

    // Try [Gmail]/All Mail — catches emails filtered out of inbox by Gmail rules
    result = await searchMailbox(client, "[Gmail]/All Mail", amount, acctTitle, since);
    if (result.verified) return result;

    // Try plain "All Mail" (non-English Gmail)
    result = await searchMailbox(client, "All Mail", amount, acctTitle, since);
    return result;
  } catch (err) {
    logger.error({ err, user: user.replace(/(.{3}).*(@.*)/, "$1***$2") }, "[gmail] IMAP connection error");
    return { verified: false };
  } finally {
    await client.logout().catch(() => {});
  }
}
