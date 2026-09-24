import { timingSafeEqual } from "node:crypto";

export const validateDeveloperToken = (token: string): void => {
  if (token.length < 32) throw new Error("Developer token must contain at least 32 characters");
};

export const authenticateDeveloperRequest = (authorization: string | undefined, token: string): boolean => {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
