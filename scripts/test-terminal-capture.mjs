#!/usr/bin/env node
/**
 * test-terminal-capture.js — write terminal events and test Panther explain.
 */
import { Store } from "../dist/src/state/store.js"
import { Panther } from "../dist/src/ingest.js"
import { TerminalAdapter } from "../dist/src/adapters/terminal.js"
import { LocalReasoner } from "../dist/src/core/reasoner.js"
import { writeFileSync, appendFileSync, unlinkSync } from "node:fs"
import { randomUUID } from "node:crypto"

const LOG = "/tmp/panther-terminal.log"
const DB = "/tmp/panther-test-state.sqlite"

// Clean slate
try { unlinkSync(DB) } catch {}

// Write a terminal failure event
const event1 = {
  command: "migrate --prod",
  cwd: "/app",
  gitBranch: "main",
  exitCode: 1,
  stderr: "database is locked",
  stdout: "",
  truncated: false,
  timestamp: new Date().toISOString(),
}
appendFileSync(LOG, JSON.stringify(event1) + "\n")
console.log("Wrote terminal failure event to", LOG)

// Write a terminal success event
const event2 = {
  command: "git status",
  cwd: "/app",
  gitBranch: "main",
  exitCode: 0,
  stderr: "",
  stdout: "On branch main\nnothing to commit, working tree clean",
  truncated: false,
  timestamp: new Date().toISOString(),
}
appendFileSync(LOG, JSON.stringify(event2) + "\n")
console.log("Wrote terminal success event to", LOG)

// Test with Panther core
const store = Store.open(DB)
const adapters = [new TerminalAdapter(LOG)]
const reasoner = new LocalReasoner()
const panther = new Panther({
  store,
  adapters,
  reasoner,
  threshold: 0.25,
  followMinutes: 25,
  insightTtlMinutes: 45,
})

console.log("\n=== TEST 1: Explain with terminal failure (onRequest) ===")
const result1 = await panther.explain({ onRequest: true, now: new Date().toISOString() })
console.log("raised:", result1.raised)
console.log("reason:", result1.decision.reason)
if (result1.live) {
  const e = result1.live.explanation
  console.log("topic:", e.topic)
  console.log("whatItMeans:", e.whatItMeans)
  console.log("whyItMattersHere:", e.whyItMattersHere)
  console.log("nextCheck:", e.nextCheck)
  console.log("observed:", JSON.stringify(e.observed))
  console.log("inferred:", JSON.stringify(e.inferred))
  console.log("unknown:", JSON.stringify(e.unknown))
  console.log("confidence:", e.confidence)
  console.log("evidence sources:", e.evidence.map(x => x.providerId))
}

console.log("\n=== TEST 2: Explain with only success (should suppress) ===")
// Clear log and write only success
writeFileSync(LOG, JSON.stringify(event2) + "\n")
const panther2 = new Panther({
  store,
  adapters,
  reasoner,
  threshold: 0.25,
  followMinutes: 25,
  insightTtlMinutes: 45,
})
const result2 = await panther2.explain({ onRequest: true, now: new Date().toISOString() })
console.log("raised:", result2.raised)
console.log("reason:", result2.decision.reason)
if (result2.live) {
  console.log("topic:", result2.live.explanation.topic)
} else {
  console.log("No live card (correctly suppressed)")
}

console.log("\n=== TEST 3: Multiple agents same failure ===")
writeFileSync(LOG, "")
const agentEvent1 = { agent: "review-agent", level: "error", message: "database is locked", timestamp: new Date().toISOString() }
const agentEvent2 = { agent: "build-agent", level: "error", message: "database is locked", timestamp: new Date().toISOString() }
appendFileSync(LOG, JSON.stringify(agentEvent1) + "\n")
appendFileSync(LOG, JSON.stringify(agentEvent2) + "\n")
const agentAdapter = new (await import("../dist/src/adapters/agent.js")).AgentEventAdapter(LOG)
const panther3 = new Panther({
  store,
  adapters: [agentAdapter],
  reasoner,
  threshold: 0.25,
  followMinutes: 25,
  insightTtlMinutes: 45,
})
const result3 = await panther3.explain({ onRequest: true, now: new Date().toISOString() })
console.log("raised:", result3.raised)
if (result3.live) {
  const e = result3.live.explanation
  console.log("topic:", e.topic)
  console.log("whatItMeans:", e.whatItMeans)
  console.log("evidence sources:", e.evidence.map(x => x.providerId))
}

console.log("\nAll tests complete.")
