// Types ctx.exports (the loopback bindings) from this Worker's own exports.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "HarmanBox" | "Registry";
  }
}
