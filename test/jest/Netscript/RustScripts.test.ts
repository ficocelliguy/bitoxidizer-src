import type { ScriptFilePath } from "../../../src/Paths/ScriptFilePath";
import { calculateRamUsage } from "../../../src/Script/RamCalculations";
import { RamCalculationErrorCode } from "../../../src/Script/RamCalculationErrorCodes";
import { startWorkerScript } from "../../../src/NetscriptWorker";
import { workerScripts } from "../../../src/Netscript/WorkerScripts";
import { RunningScript } from "../../../src/Script/RunningScript";
import { Player } from "@player";
import { GetServer } from "../../../src/Server/AllServers";
import { resetPidCounter } from "../../../src/Netscript/Pid";
import { fixDoImportIssue, initGameEnvironment, setupBasicTestingEnvironment } from "../Utilities";
import path from "path";
import { pathToFileURL } from "url";
import { execFileSync } from "child_process";
import { config } from "../../../src/NetscriptJSEvaluator";
import { getRustCompletions, getRustHover } from "../../../src/utils/rust/compileRust";

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

    it("doesn't charge for struct fields, methods and locals named like NS functions", () => {
      const code = `
#[derive(Debug, Clone, Copy, PartialEq)]
enum Action {
    Hack,
    Grow,
}

struct Plan {
    hack: u32,
    grow: u32,
}

impl Plan {
    fn hack(&self) -> u32 {
        self.hack * 2
    }

    fn run(&self, a: Action) -> u32 {
        match a {
            Action::Hack => self.hack(),
            Action::Grow => self.grow,
        }
    }
}

pub fn main() {
    let sleep = 3;
    let plan = Plan { hack: 1, grow: sleep };
    println!("{} {}", plan.run(Action::Hack), plan.run(Action::Grow));
}
`;
      expectCost(calculateRamUsage(code, "plan.rs" as ScriptFilePath, server, new Map()).cost, 0);
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

    it("show NS docs on hover and complete NS methods", () => {
      const code = `pub async fn main(ns: NS) {
    let hosts = ns.scan("home");
    ns.
}
`;
      const h = getRustHover(code, "editor.rs", 2, 21);
      expect(h?.contents).toContain("fn scan(");
      expect(h?.contents).toContain("RAM cost");
      expect(getRustHover(code, "editor.rs", 2, 9)?.contents).toContain("hosts: Vec<String>");
      const items = getRustCompletions(code, "editor.rs", 3, 8);
      const hack = items.find((c) => c.label === "hack");
      expect(hack?.detail).toBe("async fn hack(host?: String, opts?: BasicHGWOptions) -> f64");
      expect(items.find((c) => c.label === "hacknet")?.kind).toBe("field");
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

    it("ranks servers with closures and iterator adapters", async () => {
      const runningScript = await runRust(
        "rank.rs",
        `
pub async fn main(ns: NS) {
    let hosts: Vec<String> = ns.scan("home");
    let mut ranked: Vec<(String, f64)> = hosts
        .iter()
        .map(|h| (h.clone(), ns.get_server_max_money(h)))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then_with(|| a.0.cmp(&b.0)));
    let total: f64 = ranked.iter().map(|(_, m)| m).sum();
    let richest = ranked.first().map(|(h, _)| h.clone()).unwrap_or_default();
    let short = hosts.iter().filter(|h| h.len() < 10).count();
    ns.print(&format!("{} {} {} {}", ranked.len(), total, richest, short));
}
`,
      );
      const hosts = Player.getHomeComputer().serversOnNetwork.flatMap((ip) => GetServer(ip) ?? []);
      const money = hosts.map((s) => [s.hostname, "moneyMax" in s ? s.moneyMax : 0] as const);
      money.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const total = money.reduce((t, [, m]) => t + m, 0);
      const short = hosts.filter((s) => s.hostname.length < 10).length;
      expect(runningScript.logs.at(-2)).toBe(`${hosts.length} ${total} ${money[0][0]} ${short}`);
      expect(runningScript.ramUsage).toBeGreaterThan(1.6);
      expect(runningScript.logs.at(-1)).toBe("Script finished running");
    });

    it("models servers with structs, enums, Result and Display", async () => {
      const runningScript = await runRust(
        "targets.rs",
        `
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
enum Verdict {
    Hack { threads: u32 },
    Skip(String),
}

struct Target {
    host: String,
    max_money: f64,
}

impl Target {
    fn verdict(&self) -> Verdict {
        if self.max_money > 0.0 {
            Verdict::Hack { threads: 1 + self.host.len() as u32 }
        } else {
            Verdict::Skip(format!("{} has no money", self.host))
        }
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{} (\${:.0})", self.host, self.max_money)
    }
}

fn parse_threads(s: &str) -> Result<u32, String> {
    s.parse::<u32>().map_err(|e| format!("{}: {}", s, e))
}

pub async fn main(ns: NS) {
    let targets: Vec<Target> = ns
        .scan("home")
        .iter()
        .map(|h| Target { host: h.clone(), max_money: ns.get_server_max_money(h) })
        .collect();
    let hackable = targets.iter().filter(|t| matches!(t.verdict(), Verdict::Hack { .. })).count();
    ns.print(&format!("{} of {} hackable", hackable, targets.len()));
    ns.print(&format!("{}", targets[0]));
    ns.print(&format!("{:?} {:?}", parse_threads("8"), parse_threads("x")));
}
`,
      );
      const hosts = Player.getHomeComputer().serversOnNetwork.flatMap((ip) => GetServer(ip) ?? []);
      const hackable = hosts.filter((s) => "moneyMax" in s && s.moneyMax > 0).length;
      const first = hosts[0];
      const money = "moneyMax" in first ? first.moneyMax : 0;
      const logs = runningScript.logs
        .map((l) => String(l))
        .filter((l) => !l.startsWith("getServerMaxMoney") && !l.startsWith("scan"));
      expect(logs).toEqual([
        `${hackable} of ${hosts.length} hackable`,
        `${first.hostname} ($${money.toFixed(0)})`,
        `Ok(8) Err("x: invalid digit found in string")`,
        "Script finished running",
      ]);
    });

    it("splits a script across files with `mod`", async () => {
      Player.getHomeComputer().writeToScriptFile(
        "lib/targets.rs" as ScriptFilePath,
        `
pub struct Target {
    pub host: String,
    pub money: f64,
}

pub fn richest(ns: &NS, hosts: &[String]) -> Option<Target> {
    hosts
        .iter()
        .map(|h| Target { host: h.clone(), money: ns.get_server_max_money(h) })
        .max_by(|a, b| a.money.partial_cmp(&b.money).unwrap())
}

pub const LABEL: &str = "richest";
`,
      );
      const runningScript = await runRust(
        "lib/run.rs",
        `
mod targets;

use targets::{richest, Target};

pub async fn main(ns: NS) {
    let hosts = ns.scan("home");
    let best: Target = richest(&ns, &hosts).unwrap();
    ns.print(&format!("{}: {} ({})", targets::LABEL, best.host, best.money));
}
`,
      );
      const hosts = Player.getHomeComputer().serversOnNetwork.flatMap((ip) => GetServer(ip) ?? []);
      const money = (s: (typeof hosts)[number]) => ("moneyMax" in s ? s.moneyMax : 0);
      const best = hosts.reduce((a, b) => (money(b) >= money(a) ? b : a));
      expect(runningScript.logs.at(-2)).toBe(`richest: ${best.hostname} (${money(best)})`);
      // scan (0.2 GB) and getServerMaxMoney (0.1 GB, called in the module) on top of the base 1.6 GB.
      expect(runningScript.ramUsage).toBeCloseTo(1.9);
    });

    it("crawls the network with a HashSet, while let and a tuple match", async () => {
      const runningScript = await runRust(
        "crawl.rs",
        `
use std::collections::HashSet;

pub async fn main(ns: NS) {
    let home = ns.get_hostname();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue = vec![(home.clone(), 0u32)];
    let mut open = 0;
    let mut deepest = (String::new(), 0);
    while let Some((host, depth)) = queue.pop() {
        if !seen.insert(host.clone()) {
            continue;
        }
        if depth > deepest.1 {
            deepest = (host.clone(), depth);
        }
        for next in ns.scan(&host) {
            queue.push((next, depth + 1));
        }
        match (ns.get_server_num_ports_required(&host) as u32, host == home) {
            (0, false) => open += 1,
            _ => {}
        }
    }
    ns.print(&format!("{} servers, {} open, home seen {:?}, deepest {}", seen.len(), open, seen.contains(&home), deepest.1));
}
`,
      );
      expect(runningScript.logs.at(-2)).toMatch(/^\d+ servers, \d+ open, home seen true, deepest \d+$/);
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
