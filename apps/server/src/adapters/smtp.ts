import MailComposer from "nodemailer/lib/mail-composer";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import { config } from "../config";
import {
  Adapter,
  AdapterError,
  AdapterKind,
  ConfigurationError,
  TransientError,
  field,
  type TestResult,
} from "./base";
import { smtpReply } from "./smtp-reply";

/**
 * Email over SMTP: notifications to admins and sign-in details to new people.
 *
 * Works with any mail server or sending service that offers SMTP (Mailgun,
 * MailerSend, Postmark, Amazon SES, Microsoft 365, Google Workspace relay).
 *
 * One SMTP session runs the steps smtplib ran in the Python version: connect
 * (with STARTTLS first when it is chosen), sign in, send, quit. Nodemailer's
 * SMTPConnection carries the session and MailComposer builds the message.
 */

/** The SMTP session the adapter drives; tests replace it (`openSession`). */
export interface SmtpSession {
  /** Connects; with `requireTLS`, upgrades with STARTTLS before anything else. */
  connect(): Promise<void>;
  /** Whether the server offers AUTH; known once connected. */
  readonly allowsAuth: boolean;
  login(username: string, password: string): Promise<void>;
  /** A command that changes nothing (RSET): the session works. */
  check(): Promise<void>;
  send(envelope: { from: string; to: string[] }, message: Buffer): Promise<void>;
  /** Ends the session; best effort, nothing waits for it. */
  quit(): void;
  close(): void;
}

export type SmtpSessionOptions = SMTPConnection.Options;

/**
 * What Nodemailer attaches to its errors: `code` (ECONNECTION, ETIMEDOUT,
 * EAUTH, EENVELOPE, ...), the SMTP answer's `responseCode`, the `command`
 * that failed, and for a refused envelope the error of each recipient.
 */
type SmtpFailure = Error & {
  code?: string;
  originalCode?: string;
  responseCode?: number;
  command?: string;
  rejectedErrors?: { responseCode?: number }[];
  syscall?: string;
};

/** Nodemailer's codes for a session that broke off or never started. */
const UNREACHABLE = new Set(["ECONNECTION", "ESOCKET", "EDNS", "ETIMEDOUT", "EPROXY"]);
/** Nodemailer's codes for a request the server or Nodemailer refused (Python: SMTPException). */
const REFUSED = new Set(["EPROTOCOL", "EENVELOPE", "EMESSAGE", "EREQUIRETLS"]);
/** Node's codes for a TLS handshake or certificate that failed (Python: ssl.SSLError, CertificateError). */
const TLS_FAILURE =
  /^(ERR_SSL_|ERR_TLS_|ERR_OSSL_|CERT_|CRL_|UNABLE_TO_|ERROR_IN_C|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|INVALID_CA$|INVALID_PURPOSE$|PATH_LENGTH_EXCEEDED$|HOSTNAME_MISMATCH$|EPROTO$)/;

function isSmtpFailure(error: unknown): error is SmtpFailure {
  return error instanceof Error;
}

/**
 * A 4xx answer: try again later. That includes a sign-in (454), sender (451)
 * or recipients (450) the server cannot accept just now.
 */
function temporary(error: SmtpFailure): boolean {
  if (error.code === "EENVELOPE" && error.command === "RCPT TO" && Array.isArray(error.rejectedErrors)) {
    const codes = error.rejectedErrors.map((rejected) => rejected.responseCode ?? 0);
    return codes.length > 0 && codes.every((code) => code >= 400 && code < 500);
  }
  return typeof error.responseCode === "number" && error.responseCode >= 400 && error.responseCode < 500;
}

function checkHeader(value: string, what: string): string {
  if (value.includes("\r") || value.includes("\n")) {
    throw new AdapterError(`The ${what} contains a line break; the email was not sent.`);
  }
  return value;
}

/** A port as Python's int() reads it. */
function port(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value);
  throw new ConfigurationError("The port must be a number.");
}

/** Runs a step that may fail without consequence (quitting, closing). */
function quietly(step: () => void): void {
  try {
    step();
  } catch {
    // Best effort.
  }
}

/** The SMTP session of Nodemailer's SMTPConnection, with promises. */
class NodemailerSession implements SmtpSession {
  private readonly connection: SMTPConnection;
  /** Why the session ended, once it did. */
  private ended: Error | null = null;
  /** Fails the step waiting for an answer. */
  private pending: ((error: Error) => void) | null = null;

  constructor(options: SmtpSessionOptions) {
    this.connection = new SMTPConnection(options);
    // A failure arrives as an event; without a listener it would end the process.
    this.connection.on("error", (error: Error) => this.end(error));
    this.connection.on("end", () =>
      this.end(Object.assign(new Error("Connection closed"), { code: "ECONNECTION" })),
    );
  }

  get allowsAuth(): boolean {
    return this.connection.allowsAuth;
  }

  connect(): Promise<void> {
    return this.step((done) => this.connection.connect((error) => done(error ?? null)));
  }

  login(username: string, password: string): Promise<void> {
    return this.step((done) =>
      this.connection.login({ user: username, pass: password }, (error) => done(error)),
    );
  }

  check(): Promise<void> {
    return this.step((done) => this.connection.reset((error) => done(error)));
  }

  send(envelope: { from: string; to: string[] }, message: Buffer): Promise<void> {
    return this.step((done) => this.connection.send(envelope, message, (error) => done(error)));
  }

  quit(): void {
    this.connection.quit();
  }

  close(): void {
    this.connection.close();
  }

  private end(error: Error): void {
    this.ended ??= error;
    const pending = this.pending;
    this.pending = null;
    pending?.(error);
  }

  private step(start: (done: (error: Error | null) => void) => void): Promise<void> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error: Error | null) => {
        if (settled) return;
        settled = true;
        this.pending = null;
        if (error) reject(error);
        else resolve();
      };
      this.pending = done;
      start(done);
    });
  }
}

export class SmtpAdapter extends Adapter {
  static override readonly slug = "smtp";
  static override readonly label = "Email (SMTP)";
  static override readonly kind = AdapterKind.EMAIL;
  static override readonly description =
    "Sends notifications about manual tasks and the sign-in details of new accounts through any SMTP server.";
  static override readonly supportsWrite = false;
  static override readonly supportsAccountListing = false;
  static override readonly fields = [
    field("host", "SMTP server", { required: true, destination: true, placeholder: "smtp.example.invalid" }),
    field("port", "Port", { kind: "int", default: 587, destination: true }),
    field("security", "Encryption", {
      kind: "choice",
      default: "starttls",
      destination: true,
      choices: [
        ["starttls", "STARTTLS (usually port 587)"],
        ["ssl", "TLS from the start (usually port 465)"],
        ["none", "None (only inside a trusted network)"],
      ],
    }),
    field("username", "Username"),
    field("password", "Password", { kind: "secret" }),
    field("from_address", "From address", { kind: "email", required: true }),
    field("from_name", "From name", { placeholder: "IT team" }),
    field("reply_to", "Reply-to address", { kind: "email" }),
  ];

  /** Opens an SMTP session (not yet connected). Tests replace it with a fake. */
  protected openSession(options: SmtpSessionOptions): SmtpSession {
    return new NodemailerSession(options);
  }

  private async connect(): Promise<SmtpSession> {
    this.require("host", "from_address");
    const host = String(this.setting("host"));
    const serverPort = port(this.setting("port", 587));
    const security = this.setting<unknown>("security", "starttls");
    const timeout = config().PROVIDER_TIMEOUT_SECONDS * 1000;
    const session = this.openSession({
      host,
      port: serverPort,
      // TLS from the start, or STARTTLS before anything else: never plain text then.
      secure: security === "ssl",
      requireTLS: security === "starttls",
      ignoreTLS: security !== "ssl" && security !== "starttls",
      // Verified certificates, as Python's ssl.create_default_context().
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      logger: false,
    });
    try {
      await session.connect();
      if (this.setting("username")) {
        if (!session.allowsAuth) {
          throw new ConfigurationError("The SMTP server does not support the chosen encryption or sign-in.");
        }
        await session.login(String(this.setting("username")), String(this.setting("password", "")));
      }
    } catch (error) {
      quietly(() => session.close());
      throw this.translate(error, "connect");
    }
    return session;
  }

  /**
   * Maps Nodemailer's errors to adapter errors, as the Python version
   * mapped smtplib's and socket errors.
   */
  private translate(error: unknown, what: string): unknown {
    if (!isSmtpFailure(error) || error instanceof AdapterError) return error;
    const { code = "", command = "" } = error;
    const cause = { cause: error };
    if (temporary(error)) {
      return new TransientError(`The SMTP server asked to try again later (${what}).`, cause);
    }
    if (code === "EAUTH" || code === "ENOAUTH") {
      return new ConfigurationError(
        "The SMTP server refused the username or password. Check the connection's credentials.",
        cause,
      );
    }
    // The server refused STARTTLS, or refused EHLO although STARTTLS is required (Python: SMTPNotSupportedError).
    if (
      (code === "ETLS" && command === "STARTTLS" && error.responseCode) ||
      (code === "ECONNECTION" && command === "EHLO")
    ) {
      return new ConfigurationError(
        "The SMTP server does not support the chosen encryption or sign-in.",
        cause,
      );
    }
    if (code === "EENVELOPE" && command === "RCPT TO") {
      return new AdapterError("The SMTP server refused the recipient address.", cause);
    }
    if (code === "EENVELOPE" && command === "MAIL FROM") {
      return new AdapterError(
        "The SMTP server refused the from address. Check that the server may send for it.",
        cause,
      );
    }
    // The connection broke off, or the server greeted with something else than 220.
    if (code === "ECONNECTION" || (code === "EPROTOCOL" && command === "CONN")) {
      return new TransientError(`Could not reach the SMTP server (${what}).`, cause);
    }
    if (typeof error.responseCode === "number" || REFUSED.has(code)) {
      return new AdapterError(`The SMTP server rejected the request (${what}).`, cause);
    }
    if (code === "ETLS" || TLS_FAILURE.test(error.originalCode ?? code)) {
      return new ConfigurationError(
        "The TLS connection to the SMTP server failed. Check the port and encryption.",
        cause,
      );
    }
    if (UNREACHABLE.has(code) || typeof error.syscall === "string") {
      // Timeouts, refused connections, DNS failures.
      return new TransientError(`Could not reach the SMTP server (${what}).`, cause);
    }
    return error;
  }

  /** A failed test also names the server's own answer (without the login). */
  override async testConnection(): Promise<TestResult> {
    try {
      const session = await this.connect();
      try {
        await session.check();
      } catch (error) {
        throw this.translate(error, "check");
      } finally {
        quietly(() => session.quit());
      }
    } catch (error) {
      if (error instanceof AdapterError) {
        const reply = smtpReply(error.cause, {
          username: String(this.setting("username", "")),
          password: String(this.setting("password", "")),
        });
        if (reply) error.message += ` The server answered: ${reply}`;
      }
      throw error;
    }
    return { ok: true, message: `Connected to ${String(this.setting("host"))} and signed in.` };
  }

  override async sendMessage(message: {
    to: string[];
    subject: string;
    body: string;
    replyTo?: string;
  }): Promise<void> {
    const recipients = message.to
      .filter((address) => address.trim())
      .map((address) => checkHeader(address.trim(), "recipient"));
    if (recipients.length === 0) throw new AdapterError("The email has no recipient.");
    const fromAddress = checkHeader(String(this.setting("from_address", "")), "from address");
    const fromName = checkHeader(String(this.setting("from_name", "")), "from name");
    const subject = checkHeader(message.subject, "subject");
    const reply = message.replyTo || String(this.setting("reply_to", ""));
    const mail = new MailComposer({
      from: fromName ? { name: fromName, address: fromAddress } : fromAddress,
      to: recipients,
      subject,
      replyTo: reply ? checkHeader(reply, "reply-to address") : undefined,
      text: message.body,
      envelope: { from: fromAddress, to: recipients },
    }).compile();
    const raw = await mail.build();
    const session = await this.connect();
    try {
      await session.send({ from: fromAddress, to: mail.getEnvelope().to }, raw);
    } catch (error) {
      throw this.translate(error, "send");
    } finally {
      quietly(() => session.quit());
    }
  }
}
