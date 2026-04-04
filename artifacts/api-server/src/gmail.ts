import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./lib/logger.js";

export interface VerifyResult {
  verified: boolean;
  amount?: string;
}

export async function verifyPaymentByEmail(
  acctLast4: string,
  amount: string
): Promise<VerifyResult> {
  const user = process.env["GMAIL_USER"] ?? "";
  const pass = process.env["GMAIL_APP_PASSWORD"] ?? "";

  if (!user || !pass) {
    logger.warn("[gmail] GMAIL_USER or GMAIL_APP_PASSWORD not configured");
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
      // Search last 3 days for NayaPay payment emails
      const since = new Date();
      since.setDate(since.getDate() - 3);

      // Search by the amount string to narrow results
      const uids = await client.search({ since, body: amount });

      if (!uids || uids.length === 0) {
        logger.warn({ amount, acctLast4 }, "[gmail] No emails found matching amount");
        return { verified: false };
      }

      // Check from most recent to oldest
      for (let i = uids.length - 1; i >= 0; i--) {
        const uid = uids[i];
        const msg = await client.fetchOne(String(uid), { source: true });
        if (!msg) continue;
        const source = (msg as unknown as { source?: Buffer }).source;
        if (!source) continue;

        const parsed = await simpleParser(source);
        const bodyText = (parsed.text ?? "") + (typeof parsed.html === "string" ? parsed.html : "");

        // Only process NayaPay payment notification emails
        const isNayaPay =
          /nayapay/i.test(parsed.from?.text ?? "") ||
          /nayapay/i.test(bodyText) ||
          /payment.*received|money.*received|transfer.*received/i.test(bodyText);
        if (!isNayaPay) continue;

        // Extract last 4 digits of sender account number
        const acctMatch =
          bodyText.match(/[Aa]cc(?:ount)?[^0-9]{0,40}●+\s*(\d{4})/i) ??
          bodyText.match(/[Ss]ource[^0-9]{0,40}●+\s*(\d{4})/i) ??
          bodyText.match(/●{1,12}(\d{4})/);
        const foundAcct4 = acctMatch?.[1] ?? "";

        // Extract amount from email
        const amountMatch =
          bodyText.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)/i) ??
          bodyText.match(/PKR\s*([\d,]+(?:\.\d+)?)/i);
        const emailAmount = amountMatch?.[1]?.replace(/,/g, "") ?? "";

        logger.info(
          { uid, foundAcct4, providedAcct4: acctLast4, emailAmount, providedAmount: amount },
          "[gmail] Checking email"
        );

        const acctMatches = foundAcct4 === acctLast4;
        const amountMatches = !amount || !emailAmount || emailAmount === amount;

        if (acctMatches && amountMatches) {
          return { verified: true, amount: emailAmount || amount };
        }
      }

      logger.warn({ amount, acctLast4 }, "[gmail] No matching email found after checking all candidates");
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
