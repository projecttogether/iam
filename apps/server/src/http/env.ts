import type { User } from "../db/schema";

/** Variables every request carries (Hono context). */
export type AppEnv = {
  Variables: {
    requestId: string;
    /** The signed-in app user; null for anonymous requests. Set by the `authenticate` middleware. */
    user: User | null;
  };
};
