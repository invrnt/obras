import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ADMIN_BASE_PATH, ADMIN_COOKIE_NAME, ADMIN_PANEL_PATH } from "@/lib/constants";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function getAuthConfig() {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!password || !secret) {
    throw new Error("Faltan ADMIN_PASSWORD y SESSION_SECRET en el entorno.");
  }

  return { username, password, secret };
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createSessionToken() {
  const { username, secret } = getAuthConfig();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = `${username}.${expiresAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

function isValidSessionToken(token: string | undefined) {
  if (!token) return false;

  const { username, secret } = getAuthConfig();
  const lastDot = token.lastIndexOf(".");
  if (lastDot < 0) return false;

  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  const [tokenUser, expiresAt] = payload.split(".");

  return (
    tokenUser === username &&
    Number(expiresAt) > Date.now() / 1000 &&
    safeEqual(signature, sign(payload, secret))
  );
}

export async function isAdminAuthenticated() {
  const cookieStore = await cookies();
  return isValidSessionToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
}

export async function requireAdmin() {
  if (!(await isAdminAuthenticated())) {
    redirect(ADMIN_BASE_PATH);
  }
}

export async function loginAdmin(username: string, password: string) {
  const config = getAuthConfig();

  if (!safeEqual(username, config.username) || !safeEqual(password, config.password)) {
    return false;
  }

  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });

  return true;
}

export async function logoutAdmin() {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_COOKIE_NAME);
}

export async function redirectIfAdmin() {
  if (await isAdminAuthenticated()) {
    redirect(ADMIN_PANEL_PATH);
  }
}
