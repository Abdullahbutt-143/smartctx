/**
 * Obfuscates all JS files in dist/ after TypeScript compilation.
 * Run: node scripts/obfuscate-js.js
 */
const JavaScriptObfuscator = require("javascript-obfuscator");
const fs = require("fs");
const path = require("path");

const DIST_DIR = path.join(__dirname, "..", "dist");

const OBFUSCATION_OPTIONS = {
  // High protection
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: "hexadecimal",
  log: false,
  numbersToExpressions: true,
  renameGlobals: false, // keep false — we import from node_modules
  selfDefending: false, // can break in some environments
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ["base64"],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: "function",
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

// Find all .js files in dist/ (skip .map files)
const jsFiles = fs
  .readdirSync(DIST_DIR)
  .filter((f) => f.endsWith(".js") && !f.endsWith(".min.js"));

console.log(`\nObfuscating ${jsFiles.length} JS files...\n`);

for (const file of jsFiles) {
  const filePath = path.join(DIST_DIR, file);
  const code = fs.readFileSync(filePath, "utf-8");

  const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATION_OPTIONS);

  fs.writeFileSync(filePath, result.getObfuscatedCode());

  const originalSize = Buffer.byteLength(code);
  const newSize = Buffer.byteLength(result.getObfuscatedCode());
  console.log(
    `  ✓ ${file} (${(originalSize / 1024).toFixed(1)}KB → ${(newSize / 1024).toFixed(1)}KB)`
  );
}

// Remove source maps (they reveal original code)
const mapFiles = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith(".map"));
for (const file of mapFiles) {
  fs.unlinkSync(path.join(DIST_DIR, file));
  console.log(`  ✗ Removed ${file} (source map)`);
}

// Remove .d.ts files (they reveal type structure)
const dtsFiles = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith(".d.ts"));
for (const file of dtsFiles) {
  fs.unlinkSync(path.join(DIST_DIR, file));
  console.log(`  ✗ Removed ${file} (type declarations)`);
}

console.log("\n✓ Obfuscation complete! dist/ is now protected.\n");
