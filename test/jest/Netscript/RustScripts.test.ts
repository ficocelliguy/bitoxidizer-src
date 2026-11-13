import type { ScriptFilePath } from "../../../src/Paths/ScriptFilePath";
import { calculateRamUsage } from "../../../src/Script/RamCalculations";
import { RamCalculationErrorCode } from "../../../src/Script/RamCalculationErrorCodes";
import { startWorkerScript } from "../../../src/NetscriptWorker";
import { workerScripts } from "../../../src/Netscript/WorkerScripts";
import { RunningScript } from "../../../src/Script/RunningScript";
import { Player } from "@player";
import { resetPidCounter } from "../../../src/Netscript/Pid";
import { fixDoImportIssue, initGameEnvironment, setupBasicTestingEnvironment } from "../Utilities";
import path from "path";
import { pathToFileURL } from "url";
import { execFileSync } from "child_process";
import { config } from "../../../src/NetscriptJSEvaluator";

fixDoImportIssue();
initGameEnvironment();

const BaseCost = 1.6;
const HackCost = 0.1;
const GrowCost = 0.15;
const server = "testserver";

function expectCost(val: number | undefined, expected: number) {
  expect(val).toBeCloseTo(expected + BaseCost, 10);
}

describe(".rs scripts (CarciniScript)", () => {
  describe("RAM calculation", () => {
    it("charges for NS calls written in snake_case", () => {
      const code = `
pub async fn main(ns: NS) {
    let target = "joesguns";
    while ns.get_server_money_available(target) < 1000.0 {
        ns.grow(target).await;
    }
    ns.hack(target).await;
}
`;
      const result = calculateRamUsage(code, "hack.rs" as ScriptFilePath, server, new Map());
      // getServerMoneyAvailable costs 0.1 like hack.
      expectCost(result.cost, HackCost + GrowCost + 0.1);
    });

    it("costs only the base for pure computation", () => {
      const code = `
fn fib(n: u32) -> u64 {
    if n < 2 { n as u64 } else { fib(n - 1) + fib(n - 2) }
}

pub fn main() {
    println!("{}", fib(20));
}
`;
      expectCost(calculateRamUsage(code, "fib.rs" as ScriptFilePath, server, new Map()).cost, 0);
    });

    it("reports compile errors with the Rust location", () => {
      const code = `pub async fn main(ns: NS) {\n    let x = 1;\n    x = 2;\n}\n`;
      const result = calculateRamUsage(code, "bad.rs" as ScriptFilePath, server, new Map());
      expect(result.errorCode).toBe(RamCalculationErrorCode.SyntaxError);
      expect(result.errorMessage).toContain("bad.rs:3:5: cannot assign twice to immutable variable `x`");
    });
  });

  describe("Typed NS bindings", () => {
    function errorFor(body: string): string | undefined {
      const code = `pub async fn main(ns: NS) {\n    ${body}\n}\n`;
      return calculateRamUsage(code, "typed.rs" as ScriptFilePath, server, new Map()).errorMessage;
    }

    it("catches a forgotten .await", () => {
      expect(errorFor('let stolen: f64 = ns.hack("n00dles");')).toContain(
        "expected `f64`, found `impl Future<Output = f64>` (did you forget `.await`?)",
      );
    });

    it("suggests the right name for a typo", () => {
      expect(errorFor('let m = ns.get_server_max_mony("n00dles");')).toContain(
        "no method named `get_server_max_mony` found for `NS`; did you mean `get_server_max_money`?",
      );
    });

    it("types interface fields", () => {
      expect(errorFor('let ram: u32 = ns.get_server("home").max_ram;')).toContain("expected `u32`, found `f64`");
    });

    it("are up to date with NetscriptDefinitions.d.ts", () => {
      // Fails when the NS API changed without `npm run generate:rust-bindings`.
      const root = path.resolve(__dirname, "../../..");
      expect(() =>
        execFileSync(process.execPath, ["tools/generate-rust-bindings.mjs", "--check"], { cwd: root, stdio: "pipe" }),
      ).not.toThrow();
    });
  });

  describe("Execution", () => {
    beforeAll(async () => {
      // Scripts are evaluated outside Jest's sandbox (see fixDoImportIssue), so the CarciniScript
      // runtime must be installed on that realm's global too. In the browser both are `window`.
      const runtime = path.resolve(__dirname, "../../../node_modules/carciniscript/runtime/rt.js");
      await config.doImport(pathToFileURL(runtime).href as Parameters<typeof config.doImport>[0]);
    });

    beforeEach(() => {
      setupBasicTestingEnvironment();
      resetPidCounter();
    });

    async function runRust(filename: string, code: string): Promise<RunningScript> {
      const home = Player.getHomeComputer();
      home.writeToScriptFile(filename as ScriptFilePath, code);
      const script = home.scripts.get(filename as ScriptFilePath);
      if (!script) throw new Error("script was not written");
      const ramUsage = script.getRamUsage(home.scripts);
      if (!ramUsage) throw new Error(`RAM usage could not be calculated: ${script.ramCalculationError}`);
      const runningScript = new RunningScript(script, ramUsage);
      const pid = startWorkerScript(runningScript, home);
      const workerScript = workerScripts.get(pid);
      if (!workerScript) throw new Error("worker script did not start");
      await new Promise<void>((resolve) => (workerScript.atExit = new Map([["default", resolve]])));
      return runningScript;
    }

    it("runs a Rust script that calls the NS API", async () => {
      const runningScript = await runRust(
        "collatz.rs",
        `
fn collatz_len(mut n: u64) -> u32 {
    let mut steps = 0;
    while n != 1 {
        n = if n % 2 == 0 { n / 2 } else { 3 * n + 1 };
        steps += 1;
    }
    steps
}

pub async fn main(ns: NS) {
    let host = ns.get_hostname();
    let wrapped: i32 = i32::MAX;
    ns.print(&format!("{host}: collatz(27) = {}, {} {:.2}", collatz_len(27), wrapped + 1, 2.0f64.sqrt()));
}
`,
      );
      expect(runningScript.logs).toStrictEqual([
        "home: collatz(27) = 111, -2147483648 1.41",
        "Script finished running",
      ]);
    });

    it("collects NS results into a Vec", async () => {
      const runningScript = await runRust(
        "neighbors.rs",
        `
pub async fn main(ns: NS) {
    let mut names: Vec<String> = Vec::new();
    for host in ns.scan("home") {
        names.push(host);
    }
    names.sort();
    let mut lengths = vec![0usize; names.len()];
    for i in 0..names.len() {
        lengths[i] = names[i].len();
    }
    ns.print(&format!("{} neighbors, first {:?}, lengths sum {}", names.len(), names[0], {
        let mut total = 0;
        for l in &lengths {
            total += *l;
        }
        total
    }));
}
`,
      );
      const neighbors = Player.getHomeComputer().serversOnNetwork.length;
      expect(neighbors).toBeGreaterThan(0);
      // logs[0] is ns.scan's own log entry.
      expect(runningScript.logs.at(-2)).toMatch(
        new RegExp(`^${neighbors} neighbors, first "[^"]+", lengths sum \\d+$`),
      );
      expect(runningScript.logs.at(-1)).toBe("Script finished running");
    });

    it("crawls the network with while let and match", async () => {
      const runningScript = await runRust(
        "crawl.rs",
        `
pub async fn main(ns: NS) {
    let mut seen: Vec<String> = Vec::new();
    let mut queue = vec![ns.get_hostname()];
    let mut open = 0;
    while let Some(host) = queue.pop() {
        if seen.contains(&host) {
            continue;
        }
        seen.push(host.clone());
        for next in ns.scan(&host) {
            queue.push(next);
        }
        match ns.get_server_num_ports_required(&host) as u32 {
            0 => open += 1,
            _ => {}
        }
    }
    let first: Option<&String> = seen.first();
    ns.print(&format!("{} servers, {} open, first {:?}", seen.len(), open, first));
}
`,
      );
      expect(runningScript.logs.at(-2)).toMatch(/^\d+ servers, \d+ open, first Some\("home"\)$/);
      const summary = String(runningScript.logs.at(-2));
      const [servers, open] = (summary.match(/\d+/g) ?? []).map(Number);
      expect(servers).toBeGreaterThan(10);
      expect(open).toBeGreaterThan(0);
      expect(open).toBeLessThan(servers);
    });

    it("reports a panic with its Rust location", async () => {
      const consoleError = jest.spyOn(console, "error").mockImplementation(jest.fn());
      const runningScript = await runRust(
        "panics.rs",
        `
pub async fn main(ns: NS) {
    ns.print("before");
    let divisor = 0;
    if divisor == 0 {
        panic!("cannot divide by {}", divisor);
    }
}
`,
      );
      consoleError.mockRestore();
      expect(runningScript.logs[0]).toBe("before");
      expect(runningScript.logs.join("\n")).toContain("panicked at panics.rs:6:9:\ncannot divide by 0");
    });
  });
});
