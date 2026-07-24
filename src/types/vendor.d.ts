// Loose declarations for small JS-only libraries used by the relay (bundled
// into server.mjs at build time). Kept minimal on purpose.
declare module "qrcode-terminal" {
  const qrcode: {
    generate(text: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void;
  };
  export default qrcode;
}
