import { expect, it } from "vitest";
import { isValidSignature, sign } from "../src/security.js";

const BODY = Buffer.from('{"hello": "world"}');

it("correct signature is valid", () => expect(isValidSignature("secret", BODY, sign("secret", BODY))).toBe(true));
it("wrong secret is invalid", () => expect(isValidSignature("secret", BODY, sign("other-secret", BODY))).toBe(false));
it("changed body is invalid", () => expect(isValidSignature("secret", Buffer.from('{"hello": "evil"}'), sign("secret", BODY))).toBe(false));
it("missing signature is invalid", () => {
  expect(isValidSignature("secret", BODY, null)).toBe(false);
  expect(isValidSignature("secret", BODY, "")).toBe(false);
});
it("signature of a different length is invalid, not an error", () => expect(isValidSignature("secret", BODY, "abc")).toBe(false));
it("same hex as the Python app", () => {
  // python -c "import hmac,hashlib;print(hmac.new(b'secret',b'{\"hello\": \"world\"}',hashlib.sha256).hexdigest())"
  expect(sign("secret", BODY)).toBe("827662d4dae8ed964d4ab5d1d95fcc7fd9ce7e4427678cfd4b6001dca8fed06d");
});
