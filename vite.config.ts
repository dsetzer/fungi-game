import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * Stamps the build with the package version and the commit it was built from,
 * e.g. "v0.0.1 · ede284e", so a deployed page says exactly which push it runs.
 * "-dirty" marks a local build with uncommitted changes.
 */
function buildVersion(): string {
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const git = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  const hash = git("git rev-parse --short HEAD");
  const dirty = hash && git("git status --porcelain") ? "-dirty" : "";
  return hash ? `v${version} · ${hash}${dirty}` : `v${version}`;
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
  },
});
