import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logger } from "./lib/logger.js";

export interface VerifyResult {
  verified: boolean;
  senderName?: string;
  amount?: string;
}

export async function verifyPaymentByEmail(
  txid: string,
  raastLast4: string
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

      const hasTxid = bodyText.includes(txid);
      if (!hasTxid) return { verified: false };

      // Extract last 4 digits of Raast ID / IBAN from the email
      // NayaPay format: "Raast ID / IBAN ●●●●3196"
      const raastMatch =
        bodyText.match(/Raast[^0-9]{0,30}(\d{4})/i) ??
        bodyText.match(/IBAN[^0-9]{0,30}(\d{4})/i) ??
        bodyText.match(/●{1,10}(\d{4})/);
      const foundLast4 = raastMatch?.[1] ?? "";

      logger.info({ txid, foundLast4, provided: raastLast4 }, "[gmail] Raast match result");

      if (foundLast4 !== raastLast4) return { verified: false };

      const amountMatch = bodyText.match(/Rs\.?\s*([\d,]+)/i);
      const amount = amountMatch?.[1]?.replace(",", "") ?? "";

      const senderMatch =
        bodyText.match(/Source Acc\. Title[:\s]+([^\n<]+)/i) ??
        bodyText.match(/Sender[:\s]+([^\n<]+)/i);
      const senderName = senderMatch?.[1]?.trim() ?? "";

      return { verified: true, senderName, amount };
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
