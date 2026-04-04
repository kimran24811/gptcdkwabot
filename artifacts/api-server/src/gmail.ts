import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./lib/logger.js";

export interface VerifyResult {
  verified: boolean;
  amount?: string;
}

export async function verifyPaymentByEmail(
  txid: string,
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
      const since = new Date();
      since.setDate(since.getDate() - 7);

      const uids = await client.search({ since, body: txid });

      if (!uids || uids.length === 0) {
        logger.warn({ txid }, "[gmail] No email found for txid");
        return { verified: false };
      }

      const uid = uids[uids.length - 1];
      const msg = await client.fetchOne(String(uid), { source: true });
      if (!msg) return { verified: false };
      const source = (msg as unknown as { source?: Buffer }).source;
      if (!source) return { verified: false };

      const parsed = await simpleParser(source);
      const bodyText = (parsed.text ?? "") + (typeof parsed.html === "string" ? parsed.html : "");

      // Verify TxID is present
      if (!bodyText.includes(txid)) return { verified: false };

      // Extract last 4 digits of sender account number
      // NayaPay emails show patterns like:
      //   "Account ●●●●1234", "Acc. No. XXXX1234", "account ending in 1234"
      const acctMatch =
        bodyText.match(/[Aa]cc(?:ount)?[^0-9]{0,40}●+\s*(\d{4})/i) ??
        bodyText.match(/[Aa]cc(?:ount)?[^0-9]{0,40}(\d{4})\b/i) ??
        bodyText.match(/●{1,12}(\d{4})/);
      const foundAcct4 = acctMatch?.[1] ?? "";

      logger.info({ txid, foundAcct4, provided: acctLast4 }, "[gmail] Account last-4 match result");

      if (foundAcct4 !== acctLast4) return { verified: false };

      // Extract and verify amount
      const amountMatch =
        bodyText.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)/i) ??
        bodyText.match(/PKR\s*([\d,]+(?:\.\d+)?)/i);
      const emailAmount = amountMatch?.[1]?.replace(/,/g, "") ?? "";

      logger.info({ txid, emailAmount, provided: amount }, "[gmail] Amount match result");

      if (amount && emailAmount && emailAmount !== amount) {
        return { verified: false };
      }

      return { verified: true, amount: emailAmount || amount };
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
