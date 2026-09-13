const FIREFOX_HOST_REGEX = /https?:\/\/(?<host>.+?)\//u;
const TWID_REGEX = /^u=(?<id>\d+)$/u;

interface UnknownCookie {
  domain?: unknown;
  key?: unknown;
  value?: unknown;
  "Content raw"?: unknown;
  "Host raw"?: unknown;
  "Name raw"?: unknown;
}

export interface TwitterCookie {
  domain: string;
  key: string;
  value: string;
}

const isTwitterCookie = (value: unknown): value is TwitterCookie => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const cookie = value as UnknownCookie;
  return (
    typeof cookie.domain === "string" &&
    typeof cookie.key === "string" &&
    cookie.key.length > 0 &&
    typeof cookie.value === "string"
  );
};

const isFirefoxCookie = (
  value: unknown,
): value is { "Content raw": string; "Host raw": string; "Name raw": string } => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const cookie = value as UnknownCookie;
  return (
    typeof cookie["Host raw"] === "string" &&
    typeof cookie["Name raw"] === "string" &&
    cookie["Name raw"].length > 0 &&
    typeof cookie["Content raw"] === "string"
  );
};

// Cookies are decoded from user-supplied JSON at parseTwitterCookies.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const normalizeCookie = (value: unknown): TwitterCookie | undefined => {
  if (isTwitterCookie(value)) {
    return value;
  }
  if (!isFirefoxCookie(value)) {
    return;
  }

  const domain = value["Host raw"].match(FIREFOX_HOST_REGEX)?.groups?.host;
  if (!domain) {
    return;
  }

  return {
    domain,
    key: value["Name raw"],
    value: value["Content raw"],
  };
};

const isTwitterDomain = (domain: string): boolean => {
  const normalizedDomain = domain.toLowerCase().replace(/^\./u, "");
  return (
    normalizedDomain === "x.com" ||
    normalizedDomain.endsWith(".x.com") ||
    normalizedDomain === "twitter.com" ||
    normalizedDomain.endsWith(".twitter.com")
  );
};

export const getTwitterUserId = (cookies: TwitterCookie[]): string | undefined => {
  const twid = cookies.find((cookie) => cookie.key === "twid");
  if (!(twid && isTwitterDomain(twid.domain))) {
    return;
  }

  try {
    return decodeURIComponent(twid.value).match(TWID_REGEX)?.groups?.id;
  } catch {
    // A malformed percent-encoded value has no usable user ID.
  }
};

export const parseTwitterCookies = (data: string): TwitterCookie[] => {
  const parsed: unknown = JSON.parse(data);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Invalid Twitter cookies");
  }
  const normalizedCookies: TwitterCookie[] = [];
  for (const value of parsed) {
    const cookie = normalizeCookie(value);
    if (!cookie) {
      throw new Error("Invalid Twitter cookies");
    }
    normalizedCookies.push(cookie);
  }

  if (!getTwitterUserId(normalizedCookies)) {
    throw new Error("Twitter cookies do not contain a valid twid");
  }

  return normalizedCookies;
};

export const normalizeTwitterCookies = (data: string): string => JSON.stringify(parseTwitterCookies(data));
