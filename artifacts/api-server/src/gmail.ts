import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./lib/logger.js";

export interface VerifyResult {
  verified: boolean;
  amount?: string;
  messageId?: string;
}

export async function verifyPaymentByEmail(
  acctTitle: string,
  amount: string,
  credentials?: { user: string; pass: string }
): Promise<VerifyResult> {
  const user = credentials?.user || process.env["GMAIL_USER"] || "";
  const pass = credentials?.pass || process.env["GMAIL_APP_PASSWORD"] || "";

  if (!user || !pass) {
    logger.warn("[gmail] Gmail credentials not configured");
    return { verified: false };
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();

    const lock = await client.getMailboxLock("INBOX");
    try {
      // Check emails from the last 6 hours — catches slow NayaPay delivery
      const since = new Date();
      since.setHours(since.getHours() - 6);

      const uids = await client.search({ since, body: amount });

      if (!uids || uids.length === 0) {
        logger.warn({ amount, acctTitle }, "[gmail] No recent emails found matching amount");
        return { verified: false };
      }

      const titleLower = acctTitle.trim().toLowerCase();

      // Check from most recent to oldest
      for (let i = uids.length - 1; i >= 0; i--) {
        const uid = uids[i];
        const msg = await client.fetchOne(String(uid), { source: true });
        if (!msg) continue;
        const source = (msg as unknown as { source?: Buffer }).source;
        if (!source) continue;

        const parsed = await simpleParser(source);
        const bodyText = (parsed.text ?? "") + (typeof parsed.html === "string" ? parsed.html : "");
        const bodyLower = bodyText.toLowerCase();

        const isNayaPay =
          /nayapay/i.test(parsed.from?.text ?? "") ||
          /nayapay/i.test(bodyText) ||
          /payment.*received|money.*received|transfer.*received/i.test(bodyText);
        if (!isNayaPay) continue;

        const amountMatch =
          bodyText.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)/i) ??
          bodyText.match(/PKR\s*([\d,]+(?:\.\d+)?)/i);
        const emailAmount = amountMatch?.[1]?.replace(/,/g, "") ?? "";

        const titleMatches = titleLower.length > 0 && bodyLower.includes(titleLower);
        const amountMatches = !amount || !emailAmount || emailAmount === amount;

        logger.info(
          { uid, emailAmount, providedAmount: amount, titleMatches, acctTitle },
          "[gmail] Checking email"
        );

        if (titleMatches && amountMatches) {
          const messageId = (parsed.messageId as string | undefined) ?? String(uid);
          return { verified: true, amount: emailAmount || amount, messageId };
        }
      }

      logger.warn({ amount, acctTitle }, "[gmail] No matching email found");
      return { verified: false };
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ err }, "[gmail] Error checking payment email");
    return { verified: false };
  } finally {
    await client.logout().catch(() => {});
  }
}
