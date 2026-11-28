// Compiles VM Bridge (server, dashboard and CLI) into one executable.
// Usage: bun scripts/compile.ts [bun-linux-x64 | bun-linux-arm64 | bun-darwin-arm64 | bun-darwin-x64]
import tailwind from "bun-plugin-tailwind";

const target = process.argv[2] as Bun.Build.CompileTarget | undefined;
const outfile = `dist/vmbridge${target ? `-${target.replace(/^bun-/, "")}` : ""}`;
const result = await Bun.build({
  entrypoints: ["apps/cli/src/index.ts"],
  compile: { ...(target ? { target } : {}), outfile, autoloadBunfig: false, autoloadDotenv: false },
  plugins: [tailwind],
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Release builds get the Boat OAuth client ID from a repository secret.
    "process.env.VMBRIDGE_BOAT_CLIENT_ID": JSON.stringify(process.env.VMBRIDGE_BOAT_CLIENT_ID ?? ""),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built ${outfile}`);
