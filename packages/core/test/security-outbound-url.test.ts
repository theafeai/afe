import { describe, expect, it } from "vitest";
import {
  UnsafeUrlError,
  classifyAddress,
  createSafeLookup,
  validateOutboundUrl,
} from "../src/index.ts";

const resolveTo =
  (...addresses: string[]) =>
  async () =>
    addresses;

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["2606:4700:4700::1111", "public"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["127.0.0.1", "private"],
    ["100.64.0.1", "private"],
    ["::1", "private"],
    ["fd12:3456::1", "private"],
    ["169.254.169.254", "blocked"],
    ["100.100.100.200", "blocked"],
    ["fd00:ec2::254", "blocked"],
    ["0.0.0.0", "blocked"],
    ["::", "blocked"],
    ["fe80::1", "blocked"],
    ["224.0.0.1", "blocked"],
    ["255.255.255.255", "blocked"],
    ["::ffff:169.254.169.254", "blocked"],
    ["::ffff:127.0.0.1", "private"],
    ["::ffff:7f00:1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["::127.0.0.1", "blocked"],
    ["[::1]", "private"],
    ["not-an-ip", "blocked"],
  ])("%s is %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });
});

describe("validateOutboundUrl", () => {
  it("accepts an https URL that resolves to public addresses", async () => {
    const url = await validateOutboundUrl("https://argocd.example.com/api", {
      resolve: resolveTo("203.0.113.10", "2606:4700::1"),
    });
    expect(url.hostname).toBe("argocd.example.com");
  });

  it("rejects non-https, credentials, fragments and garbage", async () => {
    for (const input of [
      "http://argocd.example.com",
      "ftp://argocd.example.com",
      "file:///etc/passwd",
      "https://user:pass@argocd.example.com",
      "https://argocd.example.com/#frag",
      "not a url",
    ]) {
      await expect(
        validateOutboundUrl(input, { resolve: resolveTo("203.0.113.10") }),
      ).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it("rejects private targets unless explicitly allowed", async () => {
    const opts = { resolve: resolveTo("10.0.0.5") };
    await expect(validateOutboundUrl("https://argocd.internal", opts)).rejects.toThrow(/private/);
    await expect(
      validateOutboundUrl("https://argocd.internal", { ...opts, allowPrivateNetworks: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects if any resolved address is disallowed", async () => {
    await expect(
      validateOutboundUrl("https://mixed.example.com", {
        resolve: resolveTo("203.0.113.10", "127.0.0.1"),
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("always blocks metadata and link-local, even with private networks allowed", async () => {
    for (const input of [
      "https://169.254.169.254/latest/meta-data",
      "https://[fd00:ec2::254]/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://0x7f000001/", // WHATWG URL normalises to 127.0.0.1
    ]) {
      const allowed = input.includes("0x7f");
      const p = validateOutboundUrl(input, { allowPrivateNetworks: true });
      if (allowed) await expect(p).resolves.toBeInstanceOf(URL);
      else await expect(p).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    await expect(
      validateOutboundUrl("https://metadata.example", {
        allowPrivateNetworks: true,
        resolve: resolveTo("169.254.169.254"),
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("blocks numeric IPv4 encodings of loopback by default", async () => {
    await expect(validateOutboundUrl("https://0x7f000001/")).rejects.toThrow(/private/);
    await expect(validateOutboundUrl("https://2130706433/")).rejects.toThrow(/private/);
    await expect(validateOutboundUrl("https://[::1]:8080/")).rejects.toThrow(/private/);
  });

  it("allows plain http only for opted-in private networks", async () => {
    const resolve = resolveTo("10.0.0.5");
    await expect(
      validateOutboundUrl("http://argocd.internal", { resolve, allowInsecureHttp: true }),
    ).rejects.toThrow(/https/);
    await expect(
      validateOutboundUrl("http://argocd.internal", {
        resolve,
        allowInsecureHttp: true,
        allowPrivateNetworks: true,
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("reports unresolvable hosts", async () => {
    await expect(
      validateOutboundUrl("https://nx.example", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/could not be resolved/);
    await expect(
      validateOutboundUrl("https://nx.example", { resolve: resolveTo() }),
    ).rejects.toThrow(/could not be resolved/);
  });
});

describe("createSafeLookup", () => {
  const call = (lookup: ReturnType<typeof createSafeLookup>, host: string, all = false) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>(
      (resolve) =>
        lookup(host, { all }, (err, address, family) => resolve({ err, address, family })),
    );

  it("returns allowed addresses in both callback shapes", async () => {
    const lookup = createSafeLookup({ resolve: resolveTo("203.0.113.10") });
    expect(await call(lookup, "a.example")).toEqual({
      err: null,
      address: "203.0.113.10",
      family: 4,
    });
    expect((await call(lookup, "a.example", true)).address).toEqual([
      { address: "203.0.113.10", family: 4 },
    ]);
  });

  it("refuses a rebinding answer at connect time", async () => {
    let n = 0;
    const policy = {
      resolve: async () => (n++ === 0 ? ["203.0.113.10"] : ["169.254.169.254"]),
    };
    await validateOutboundUrl("https://rebind.example", policy);
    const { err } = await call(createSafeLookup(policy), "rebind.example");
    expect(err?.code).toBe("EAFE_UNSAFE_ADDRESS");
  });

  it("honours allowPrivateNetworks", async () => {
    const resolve = resolveTo("10.0.0.5");
    expect((await call(createSafeLookup({ resolve }), "argocd")).err).not.toBeNull();
    expect(
      (await call(createSafeLookup({ resolve, allowPrivateNetworks: true }), "argocd")).err,
    ).toBeNull();
  });
});
