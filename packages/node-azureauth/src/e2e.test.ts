import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const MAIN_PACKAGE_DIR = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.resolve(ROOT_DIR, "packages");
const TEST_DIR = path.join(ROOT_DIR, ".e2e-test");

const VERDACCIO_BIN = path.join(
  MAIN_PACKAGE_DIR,
  "node_modules",
  ".bin",
  "verdaccio",
);
const NPM_CLI_LOGIN_BIN = path.join(
  MAIN_PACKAGE_DIR,
  "node_modules",
  ".bin",
  "npm-cli-login",
);

const VERDACCIO_PORT = 4873;
const VERDACCIO_URL = `http://localhost:${VERDACCIO_PORT}`;

// Read version from platform package
const platformPkgPath = path.join(
  PACKAGES_DIR,
  "azureauth-darwin-arm64",
  "package.json",
);
const BINARY_VERSION = fs.existsSync(platformPkgPath)
  ? JSON.parse(fs.readFileSync(platformPkgPath, "utf-8")).version
  : "0.8.4";

let verdaccioProcess: ChildProcess | null = null;

function exec(cmd: string, options: { cwd?: string } = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf-8", ...options });
}

async function packageExistsInRegistry(
  packageName: string,
  version: string,
): Promise<boolean> {
  try {
    const result = exec(
      `npm view ${packageName}@${version} version --registry ${VERDACCIO_URL}`,
    );
    return result.trim() === version;
  } catch {
    return false;
  }
}

async function startVerdaccio(): Promise<void> {
  const configDir = path.join(TEST_DIR, "verdaccio");
  fs.mkdirSync(configDir, { recursive: true });

  const config = `
storage: ${path.join(configDir, "storage")}
auth:
  htpasswd:
    file: ${path.join(configDir, "htpasswd")}
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  "@azureauth/*":
    access: $all
    publish: $all
  "azureauth":
    access: $all
    publish: $all
  "**":
    access: $all
    publish: $all
    proxy: npmjs
log:
  type: stdout
  format: pretty
  level: warn
`;

  fs.writeFileSync(path.join(configDir, "config.yaml"), config);

  verdaccioProcess = spawn(
    VERDACCIO_BIN,
    ["--config", path.join(configDir, "config.yaml")],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Verdaccio startup timeout")),
      30000,
    );

    verdaccioProcess!.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("http address")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    verdaccioProcess!.stderr?.on("data", (data: Buffer) => {
      console.error(data.toString());
    });

    verdaccioProcess!.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Login to verdaccio
  exec(
    `"${NPM_CLI_LOGIN_BIN}" -u test -p test -e test@test.com -r ${VERDACCIO_URL}`,
  );
}

function stopVerdaccio() {
  if (verdaccioProcess) {
    verdaccioProcess.kill();
    verdaccioProcess = null;
  }
}

function cleanup() {
  stopVerdaccio();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("azureauth optionalDependencies e2e", () => {
  beforeAll(async () => {
    // Check if platform packages have binaries
    const hasBinaries =
      fs.existsSync(
        path.join(
          PACKAGES_DIR,
          "azureauth-darwin-arm64",
          "bin",
          "azureauth",
        ),
      ) ||
      fs.existsSync(
        path.join(
          PACKAGES_DIR,
          "azureauth-win32-x64",
          "bin",
          "azureauth.exe",
        ),
      );

    if (!hasBinaries) {
      // Download binaries first
      console.log("Downloading platform binaries...");
      exec("node scripts/publish-all.mjs --dry-run", { cwd: MAIN_PACKAGE_DIR });
    }

    // Clean and create test directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Start verdaccio
    await startVerdaccio();
  }, 120000); // 2 minute timeout for setup

  afterAll(() => {
    cleanup();
  });

  it("should publish platform packages to verdaccio", async () => {
    const platforms = [
      { dir: "azureauth-darwin-arm64", name: "@azureauth/darwin-arm64" },
      { dir: "azureauth-darwin-x64", name: "@azureauth/darwin-x64" },
      { dir: "azureauth-win32-x64", name: "@azureauth/win32-x64" },
    ];

    for (const { dir, name } of platforms) {
      const pkgDir = path.join(PACKAGES_DIR, dir);

      // Publish
      exec(`npm publish --registry ${VERDACCIO_URL}`, { cwd: pkgDir });

      // Verify package exists in registry
      const exists = await packageExistsInRegistry(name, BINARY_VERSION);
      expect(exists).toBe(true);
    }
  }, 60000);

  it("should publish main package with optionalDependencies to verdaccio", async () => {
    const mainPkgPath = path.join(MAIN_PACKAGE_DIR, "package.json");
    const mainPkg = JSON.parse(fs.readFileSync(mainPkgPath, "utf-8"));
    const originalPkg = JSON.stringify(mainPkg, null, 2);
    const mainVersion = mainPkg.version;

    // Add optionalDependencies
    mainPkg.optionalDependencies = {
      "@azureauth/darwin-arm64": BINARY_VERSION,
      "@azureauth/darwin-x64": BINARY_VERSION,
      "@azureauth/win32-x64": BINARY_VERSION,
    };

    fs.writeFileSync(mainPkgPath, JSON.stringify(mainPkg, null, 2) + "\n");

    try {
      // Publish
      exec(`npm publish --registry ${VERDACCIO_URL}`, {
        cwd: MAIN_PACKAGE_DIR,
      });

      // Verify package exists in registry
      const exists = await packageExistsInRegistry("azureauth", mainVersion);
      expect(exists).toBe(true);

      // Verify optionalDependencies are set correctly
      const viewResult = exec(
        `npm view azureauth@${mainVersion} optionalDependencies --registry ${VERDACCIO_URL} --json`,
      );
      const optDeps = JSON.parse(viewResult);
      expect(optDeps["@azureauth/darwin-arm64"]).toBe(BINARY_VERSION);
      expect(optDeps["@azureauth/darwin-x64"]).toBe(BINARY_VERSION);
      expect(optDeps["@azureauth/win32-x64"]).toBe(BINARY_VERSION);
    } finally {
      // Restore original package.json
      fs.writeFileSync(mainPkgPath, originalPkg + "\n");
    }
  }, 30000);

  it("should install azureauth and resolve binary from optionalDependencies", () => {
    const testProjectDir = path.join(TEST_DIR, "test-project");
    fs.mkdirSync(testProjectDir, { recursive: true });

    // Create test package.json
    fs.writeFileSync(
      path.join(testProjectDir, "package.json"),
      JSON.stringify(
        { name: "e2e-test", version: "1.0.0", type: "module" },
        null,
        2,
      ),
    );

    // Create .npmrc to use verdaccio
    fs.writeFileSync(
      path.join(testProjectDir, ".npmrc"),
      `registry=${VERDACCIO_URL}\n`,
    );

    // Install azureauth
    exec("npm install azureauth", { cwd: testProjectDir });

    // Create and run test script
    const testScript = `
import { azureAuthCommand } from "azureauth";
import fs from "node:fs";

const binaryPath = azureAuthCommand();

// Output for assertion
console.log("BINARY_PATH:" + binaryPath);
console.log("EXISTS:" + fs.existsSync(binaryPath));
console.log("FROM_OPTIONAL_DEP:" + binaryPath.includes("@azureauth"));
`;

    fs.writeFileSync(path.join(testProjectDir, "test.mjs"), testScript);

    const output = exec("node test.mjs", { cwd: testProjectDir });

    // Parse output
    const binaryPath = output.match(/BINARY_PATH:(.+)/)?.[1];
    const exists = output.includes("EXISTS:true");
    const fromOptionalDep = output.includes("FROM_OPTIONAL_DEP:true");

    expect(binaryPath).toBeTruthy();
    expect(exists).toBe(true);
    expect(fromOptionalDep).toBe(true);
  }, 60000);
});
