#!/usr/bin/env node
/**
 * verify-live-capture.mjs — verify Panther explains live terminal log events.
 */
import { Store } from "../dist/src/state/store.js"
import { Panther } from "../dist/src/ingest.js"
import { TerminalAdapter } from "../dist/src/adapters/terminal.js"
import { LocalReasoner } from "../dist/src/core/reasoner.js"

const LOG = "/tmp/panther-terminal.log"
const DB = "/tmp/panther-live-verify.sqlite"

try { require("node:fs").unlinkSync(DB) } catch {}

const store = Store.open(DB)
const adapters = [new TerminalAdapter(LOG)]
const reasoner = new LocalReasoner()
const panther = new Panther({ store, adapters, reasoner, threshold: 0.25, followMinutes: 25, insightTtlMinutes: 45 })

const now = new Date().toISOString()
console.log("=== Testing explain against live terminal log ===")
const result = await panther.explain({ onRequest: true, now })

console.log("raised:", result.raised)
console.log("reason:", result.decision.reason)
if (result.live) {
  const e = result.live.explanation
  console.log("\n--- Explanation ---")
  console.log("Topic:", e.topic)
  console.log("What it means:", e.whatItMeans)
  console.log("Why it matters here:", e.whyItMattersHere)
  console.log("Next check:", e.nextCheck)
  console.log("Confidence:", e.confidence)
  console.log("Evidence sources:", e.evidence.map(x => x.providerId))
  console.log("Observed:", e.observed.join(" | "))
  console.log("Inferred:", e.inferred.join(" | "))
  console.log("Unknown:", e.unknown.join(" | "))
} else {
  console.log("No live card (suppressed)")
}
