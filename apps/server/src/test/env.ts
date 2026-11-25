/**
 * Environment of every test process. Integration tests use TEST_DATABASE_URL
 * (default: the iam_test database of compose.dev.yaml).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://iam:iam@localhost:55438/iam_test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_URL = "http://localhost:8000";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-1234";
process.env.LOG_LEVEL = "silent";
process.env.OIDC_ISSUER ??= "http://localhost:8098/realms/iam";
process.env.OIDC_CLIENT_ID ??= "iam";
process.env.OIDC_CLIENT_SECRET ??= "test-client-secret";
process.env.WORKER_ALIVE_FILE ??= `/tmp/iam-test-worker-alive-${process.pid}`;
