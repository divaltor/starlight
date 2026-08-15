import { describe, expect, test } from "bun:test";
import {
	getTwitterUserId,
	normalizeTwitterCookies,
	parseTwitterCookies,
} from "../src/services/twitter-cookies";

const normalizedCookie = (domain: string, value = "u%3D123456") => [
	{ domain, key: "auth_token", value: "token" },
	{ domain, key: "twid", value },
];

describe("Twitter cookies", () => {
	test("normalizes a Firefox Cookie Quick Manager export", () => {
		const exported = [
			{
				"Host raw": "https://x.com/",
				"Name raw": "auth_token",
				"Content raw": "token",
			},
			{
				"Host raw": "https://x.com/",
				"Name raw": "twid",
				"Content raw": "u%3D123456",
			},
		];

		expect(parseTwitterCookies(JSON.stringify(exported))).toEqual(normalizedCookie("x.com"));
	});

	test("preserves the current normalized shape", () => {
		const cookies = normalizedCookie(".x.com");
		expect(parseTwitterCookies(JSON.stringify(cookies))).toEqual(cookies);
		expect(normalizeTwitterCookies(JSON.stringify(cookies))).toBe(JSON.stringify(cookies));
		expect(getTwitterUserId(normalizedCookie("x.com", "u=123456"))).toBe("123456");
	});

	test.each([
		"x.com",
		".x.com",
		"api.x.com",
		".api.x.com",
		"twitter.com",
		".twitter.com",
		"mobile.twitter.com",
	])("accepts the Twitter domain boundary: %s", (domain) => {
		expect(getTwitterUserId(normalizedCookie(domain))).toBe("123456");
	});

	test.each(["evilx.com", ".evilx.com", "x.com.evil.test", "eviltwitter.com"])(
		"rejects a Twitter domain lookalike: %s",
		(domain) => {
			expect(() => parseTwitterCookies(JSON.stringify(normalizedCookie(domain)))).toThrow();
		},
	);

	test.each(["prefixu%3D123456", "u%3D123456suffix", "x%3Du%3D123456", "%E0%A4%A"])(
		"rejects a malformed twid value: %s",
		(value) => {
			expect(() => parseTwitterCookies(JSON.stringify(normalizedCookie("x.com", value)))).toThrow();
		},
	);

	test.each([
		[{ "Host raw": "https://x.com/", "Name raw": "twid" }],
		[{ "Host raw": 42, "Name raw": "twid", "Content raw": "u%3D123456" }],
		[{ "Host raw": "x.com", "Name raw": "twid", "Content raw": "u%3D123456" }],
	])("rejects a malformed Firefox export", (cookies) => {
		expect(() => parseTwitterCookies(JSON.stringify(cookies))).toThrow("Invalid Twitter cookies");
	});
});
