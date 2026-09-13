import { afterEach, describe, expect, it } from "vitest";
import { resolvePublicOrigin } from "./redirect-url";

function makeRequest(opts: {
  url?: string;
  headers?: Record<string, string>;
} = {}): Request {
  const url = opts.url ?? "http://localhost:3000/signup";
  const headers = new Headers(opts.headers ?? {});
  return new Request(url, { headers });
}

describe("resolvePublicOrigin", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it("prefers NEXT_PUBLIC_SITE_URL over the request origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://wacrm.example/";
    expect(
      resolvePublicOrigin(
        makeRequest({ url: "http://localhost:3000/signup" }),
      ),
    ).toBe("https://wacrm.example");
  });

  it("returns the request origin when NEXT_PUBLIC_SITE_URL is unset", () => {
    expect(
      resolvePublicOrigin(
        makeRequest({ url: "http://localhost:3000/signup" }),
      ),
    ).toBe("http://localhost:3000");
  });

  it("uses https when the request arrives over TLS", () => {
    expect(
      resolvePublicOrigin(
        makeRequest({ url: "https://wacrm.example/signup" }),
      ),
    ).toBe("https://wacrm.example");
  });

  it("honours x-forwarded-proto and x-forwarded-host when present", () => {
    expect(
      resolvePublicOrigin(
        makeRequest({
          url: "http://internal/signup",
          headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "wacrm.example",
          },
        }),
      ),
    ).toBe("https://wacrm.example");
  });
});
