import { createServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, overrideConfigForTests } from "../config";
import { AdapterError, ConfigurationError, TransientError } from "./base";
import { SmtpAdapter, type SmtpSession, type SmtpSessionOptions } from "./smtp";

const CONFIG = {
  host: "smtp.example.invalid",
  port: 587,
  username: "mailer",
  password: "mail-secret",
  from_address: "it@example.invalid",
  from_name: "IT team",
};

type Step = "connect" | "login" | "check" | "send";
type Call = string | [string, string, string];

/** Stands in for an SMTP session, as the Python tests' FakeSMTP for smtplib.SMTP. */
class FakeSMTP implements SmtpSession {
  static instances: FakeSMTP[] = [];
  static failOn: Partial<Record<Step, Error>> = {};

  calls: Call[] = [];
  sent: { message: Buffer; envelope: { from: string; to: string[] } }[] = [];
  allowsAuth = true;

  constructor(readonly options: SmtpSessionOptions) {
    FakeSMTP.instances.push(this);
  }

  private maybeFail(step: Step): void {
    const failure = FakeSMTP.failOn[step];
    if (failure) throw failure;
  }

  async connect(): Promise<void> {
    this.calls.push("connect");
    this.maybeFail("connect");
  }

  async login(username: string, password: string): Promise<void> {
    this.calls.push(["login", username, password]);
    this.maybeFail("login");
  }

  async check(): Promise<void> {
    this.calls.push("check");
    this.maybeFail("check");
  }

  async send(envelope: { from: string; to: string[] }, message: Buffer): Promise<void> {
    this.calls.push("send");
    this.maybeFail("send");
    this.sent.push({ message, envelope });
  }

  quit(): void {
    this.calls.push("quit");
  }

  close(): void {
    this.calls.push("close");
  }
}

/** The adapter with the fake session. */
class Smtp extends SmtpAdapter {
  protected override openSession(options: SmtpSessionOptions): SmtpSession {
    return new FakeSMTP(options);
  }
}

/** An error as Nodemailer reports it. */
function smtpError(message: string, details: Record<string, unknown>): Error {
  return Object.assign(new Error(message), details);
}

/** Headers and body of a built message. */
function parse(message: Buffer) {
  const text = message.toString();
  const end = text.indexOf("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of text
    .slice(0, end)
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { header: (name: string) => headers.get(name.toLowerCase()), body: text.slice(end + 4) };
}

/** The error a promise fails with. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("The promise did not fail");
}

const MESSAGE = { to: ["a@example.invalid"], subject: "Hi", body: "Body" };

describe("SMTP", () => {
  let timeout: number;
  beforeEach(() => {
    FakeSMTP.instances = [];
    FakeSMTP.failOn = {};
    timeout = config().PROVIDER_TIMEOUT_SECONDS;
  });
  afterEach(() => overrideConfigForTests({ PROVIDER_TIMEOUT_SECONDS: timeout }));

  it("sends with STARTTLS and a login, and builds the message", async () => {
    overrideConfigForTests({ PROVIDER_TIMEOUT_SECONDS: 7 });

    await new Smtp(CONFIG).sendMessage({
      to: ["new.person@example.invalid"],
      subject: "Your account",
      body: "Welcome aboard.",
      replyTo: "help@example.invalid",
    });

    expect(FakeSMTP.instances).toHaveLength(1);
    const server = FakeSMTP.instances[0]!;
    expect(server.options).toMatchObject({
      host: "smtp.example.invalid",
      port: 587,
      connectionTimeout: 7000,
      greetingTimeout: 7000,
      socketTimeout: 7000,
    });
    // STARTTLS before anything else, with a verified certificate.
    expect(server.options).toMatchObject({
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
    });
    expect(server.calls).toEqual(["connect", ["login", "mailer", "mail-secret"], "send", "quit"]);
    const { message, envelope } = server.sent[0]!;
    expect(envelope.from).toBe("it@example.invalid");
    expect(envelope.to).toEqual(["new.person@example.invalid"]);
    const parsed = parse(message);
    expect(parsed.header("From")).toBe("IT team <it@example.invalid>");
    expect(parsed.header("To")).toBe("new.person@example.invalid");
    expect(parsed.header("Subject")).toBe("Your account");
    expect(parsed.header("Reply-To")).toBe("help@example.invalid");
    expect(parsed.body.trim()).toBe("Welcome aboard.");
  });

  it("uses TLS from the start without a login", async () => {
    const settings = {
      host: "smtp.example.invalid",
      port: 465,
      security: "ssl",
      from_address: "it@example.invalid",
    };

    await new Smtp(settings).sendMessage({ to: ["a@example.invalid"], subject: "Hi", body: "Body" });

    expect(FakeSMTP.instances).toHaveLength(1);
    const server = FakeSMTP.instances[0]!;
    expect(server.options).toMatchObject({ port: 465, secure: true, tls: { rejectUnauthorized: true } });
    expect(server.calls).toEqual(["connect", "send", "quit"]);
  });

  it("uses the configured reply-to address by default", async () => {
    await new Smtp({ ...CONFIG, reply_to: "desk@example.invalid" }).sendMessage(MESSAGE);

    const message = FakeSMTP.instances[0]!.sent[0]!.message;
    expect(parse(message).header("Reply-To")).toBe("desk@example.invalid");
  });

  it("treats a failed login as a configuration error", async () => {
    FakeSMTP.failOn = {
      login: smtpError("Invalid login: 535 bad credentials", {
        code: "EAUTH",
        responseCode: 535,
        command: "AUTH PLAIN",
      }),
    };

    const error = await failure(new Smtp(CONFIG).sendMessage(MESSAGE));

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).not.toContain("mail-secret");
    expect(FakeSMTP.instances[0]!.calls.at(-1)).toBe("close");
  });

  it.each([
    ["a timeout", smtpError("Timeout", { code: "ETIMEDOUT" })],
    [
      "a refused connection",
      smtpError("connect ECONNREFUSED", { code: "ESOCKET", originalCode: "ECONNREFUSED" }),
    ],
    [
      "a broken connection",
      smtpError("Connection closed unexpectedly", { code: "ECONNECTION", command: "CONN" }),
    ],
    [
      "a 451 answer",
      smtpError("Message failed: 451 try later", { code: "EMESSAGE", responseCode: 451, command: "DATA" }),
    ],
  ])("treats %s as transient", async (_name, error) => {
    FakeSMTP.failOn = { send: error };

    await expect(new Smtp(CONFIG).sendMessage(MESSAGE)).rejects.toBeInstanceOf(TransientError);
  });

  it("treats an unreachable server as transient", async () => {
    FakeSMTP.failOn = {
      connect: smtpError("connect EHOSTUNREACH", {
        code: "ESOCKET",
        originalCode: "EHOSTUNREACH",
        command: "CONN",
      }),
    };

    await expect(new Smtp(CONFIG).sendMessage(MESSAGE)).rejects.toBeInstanceOf(TransientError);
  });

  it("treats a refused recipient as an adapter error", async () => {
    FakeSMTP.failOn = {
      send: smtpError("Can't send mail - all recipients were rejected: 550 no such user", {
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 550,
        rejected: ["a@example.invalid"],
        rejectedErrors: [{ responseCode: 550 }],
      }),
    };

    const error = await failure(new Smtp(CONFIG).sendMessage(MESSAGE));

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).not.toBeInstanceOf(TransientError);
  });

  it("treats a refused sender as an adapter error", async () => {
    FakeSMTP.failOn = {
      send: smtpError("Mail command failed: 553 not allowed", {
        code: "EENVELOPE",
        command: "MAIL FROM",
        responseCode: 553,
      }),
    };

    const error = await failure(new Smtp(CONFIG).sendMessage(MESSAGE));

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).not.toBeInstanceOf(TransientError);
  });

  it.each([
    { to: ["a@example.invalid"], subject: "Hi\r\nBcc: x@example.invalid", body: "B" },
    { to: ["a@example.invalid\nBcc: x@example.invalid"], subject: "Hi", body: "B" },
    { to: ["a@example.invalid"], subject: "Hi", body: "B", replyTo: "r@example.invalid\r\nX: y" },
  ])("refuses header injection before connecting (%#)", async (message) => {
    await expect(new Smtp(CONFIG).sendMessage(message)).rejects.toBeInstanceOf(AdapterError);

    expect(FakeSMTP.instances).toEqual([]);
  });

  it("refuses an email without recipients", async () => {
    await expect(
      new Smtp(CONFIG).sendMessage({ to: [" "], subject: "Hi", body: "Body" }),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("signs in without sending in the connection test", async () => {
    const result = await new Smtp(CONFIG).testConnection();

    expect(FakeSMTP.instances).toHaveLength(1);
    const server = FakeSMTP.instances[0]!;
    expect(result.ok).toBe(true);
    expect(server.calls).toEqual(["connect", ["login", "mailer", "mail-secret"], "check", "quit"]);
    expect(server.sent).toEqual([]);
  });

  it("needs a host and a from address for the connection test", async () => {
    await expect(new Smtp({ host: "smtp.example.invalid" }).testConnection()).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    expect(FakeSMTP.instances).toEqual([]);
  });

  it.each([
    [
      "login",
      smtpError("Invalid login: 454 temporary authentication failure", { code: "EAUTH", responseCode: 454 }),
    ],
    [
      "send",
      smtpError("Mail command failed: 451 try later", {
        code: "EENVELOPE",
        command: "MAIL FROM",
        responseCode: 451,
      }),
    ],
    [
      "send",
      smtpError("Can't send mail - all recipients were rejected: 450 mailbox busy", {
        code: "EENVELOPE",
        command: "RCPT TO",
        responseCode: 450,
        rejected: ["a@example.invalid"],
        rejectedErrors: [{ responseCode: 450 }],
      }),
    ],
  ] as const)("treats a temporary refusal at %s as transient", async (step, error) => {
    FakeSMTP.failOn = { [step]: error };

    await expect(new Smtp(CONFIG).sendMessage(MESSAGE)).rejects.toBeInstanceOf(TransientError);
  });
});

// Not in the Python suite: the real session (Nodemailer's SMTPConnection)
// against a scripted SMTP server, so the errors the mapping above relies on
// are the ones Nodemailer reports.

type Script = { greet?: boolean; auth?: string; rcpt?: string };

async function scriptedServer(script: Script = {}) {
  const commands: string[] = [];
  const data: string[] = [];
  const sockets = new Set<Socket>();
  const login = `AUTH PLAIN ${Buffer.from("\0mailer\0mail-secret").toString("base64")}`;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (script.greet === false) return;
    socket.write("220 smtp.test ESMTP\r\n");
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 queued\r\n");
          } else {
            data.push(line);
          }
          continue;
        }
        commands.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-smtp.test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (verb === "AUTH")
          socket.write(
            `${line === login ? "235 2.7.0 ok" : (script.auth ?? "535 5.7.8 bad credentials")}\r\n`,
          );
        else if (verb === "MAIL" || verb === "RSET") socket.write("250 ok\r\n");
        else if (verb === "RCPT") socket.write(script.rcpt ?? "250 ok\r\n");
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 5.5.1 not implemented\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    commands,
    data,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("SMTP through a real session", () => {
  let server: Awaited<ReturnType<typeof scriptedServer>> | null = null;
  let timeout: number;
  beforeEach(() => {
    timeout = config().PROVIDER_TIMEOUT_SECONDS;
  });
  afterEach(async () => {
    overrideConfigForTests({ PROVIDER_TIMEOUT_SECONDS: timeout });
    await server?.close();
    server = null;
  });

  function settings(port: number, values: Record<string, unknown> = {}) {
    return { ...CONFIG, host: "127.0.0.1", port, security: "none", ...values };
  }

  it("signs in, sends and quits", async () => {
    server = await scriptedServer();

    await new SmtpAdapter(settings(server.port)).sendMessage(MESSAGE);

    await vi.waitFor(() => expect(server!.commands.at(-1)).toBe("QUIT"));
    expect(server.commands.slice(1)).toEqual([
      expect.stringMatching(/^AUTH PLAIN /),
      "MAIL FROM:<it@example.invalid>",
      "RCPT TO:<a@example.invalid>",
      "DATA",
      "QUIT",
    ]);
    expect(server.data).toContain("From: IT team <it@example.invalid>");
    expect(server.data).toContain("Subject: Hi");
  });

  it("checks the session in the connection test", async () => {
    server = await scriptedServer();

    const result = await new SmtpAdapter(settings(server.port)).testConnection();

    expect(result).toEqual({ ok: true, message: "Connected to 127.0.0.1 and signed in." });
    expect(server.commands).toContain("RSET");
  });

  it("names the server's answer in a failed connection test", async () => {
    server = await scriptedServer({ auth: "535 5.7.8 mailer: wrong is not the password" });

    const error = await failure(
      new SmtpAdapter(settings(server.port, { password: "wrong" })).testConnection(),
    );

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toBe(
      "The SMTP server refused the username or password. Check the connection's credentials. The server answered: 535 5.7.8 ***: *** is not the password",
    );
  });

  it("never goes on without STARTTLS when it is chosen", async () => {
    server = await scriptedServer();

    const error = await failure(
      new SmtpAdapter(settings(server.port, { security: "starttls" })).sendMessage(MESSAGE),
    );

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toBe("The SMTP server does not support the chosen encryption or sign-in.");
    expect(server.commands.some((command) => command.startsWith("AUTH"))).toBe(false);
  });

  it("treats a refused password as a configuration error", async () => {
    server = await scriptedServer();

    const error = await failure(
      new SmtpAdapter(settings(server.port, { password: "wrong" })).sendMessage(MESSAGE),
    );

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toBe(
      "The SMTP server refused the username or password. Check the connection's credentials.",
    );
  });

  it.each([
    ["550 5.1.1 no such user", AdapterError, "The SMTP server refused the recipient address."],
    ["450 4.2.1 mailbox busy", TransientError, "The SMTP server asked to try again later (send)."],
  ])("maps a recipient refused with %s", async (reply, kind, message) => {
    server = await scriptedServer({ rcpt: `${reply}\r\n` });

    const error = await failure(new SmtpAdapter(settings(server.port)).sendMessage(MESSAGE));

    expect(error).toBeInstanceOf(kind);
    expect(error.message).toBe(message);
  });

  it("treats a server that does not greet as transient", async () => {
    server = await scriptedServer({ greet: false });
    overrideConfigForTests({ PROVIDER_TIMEOUT_SECONDS: 0.2 });

    const error = await failure(new SmtpAdapter(settings(server.port)).sendMessage(MESSAGE));

    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toBe("Could not reach the SMTP server (connect).");
  });

  it("treats a refused connection as transient", async () => {
    const closed = await scriptedServer();
    await closed.close();

    const error = await failure(new SmtpAdapter(settings(closed.port)).sendMessage(MESSAGE));

    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toBe("Could not reach the SMTP server (connect).");
  });
});
