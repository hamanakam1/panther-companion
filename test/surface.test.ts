import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalAdapter } from "../src/adapters/terminal.js";
import type { Adapter } from "../src/adapters/adapter.js";
import { createContext, runInContext } from "node:vm";
import { Store } from "../src/state/store.js";
import { Panther } from "../src/ingest.js";
import { LocalReasoner } from "../src/core/reasoner.js";
import { CompanionController } from "../src/controller.js";

const html = readFileSync(new URL("../../surface/card.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Exercise the shipped event handlers with the real controller, without native
// Electron, browser permissions, a production database, or a DOM dependency.
class Element {
  value = ""; disabled = false; hidden = false; open = false; checked = false; required = false;
  className = ""; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  children: Element[] = []; parent: Element | null = null; focused = false; private text = "";
  files: { size: number; text(): Promise<string> }[] = [];
  onclick: (() => unknown) | null = null; oninput: (() => unknown) | null = null; onchange: (() => unknown) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => unknown) | null = null;
  listeners: Record<string, (() => unknown)[]> = {};
  constructor(readonly id = "") {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
  prepend(child: Element) { child.parent = this; this.children.unshift(child); }
  replaceChildren() { this.text = ""; this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  querySelectorAll(selector: string): Element[] { return this.children.filter(child => selector === "[data-error]" && child.dataset.error); }
  addEventListener(type: string, listener: () => unknown) { (this.listeners[type] ??= []).push(listener); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.forEach(listener => listener()); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  click() { if (!this.disabled) return this.onclick?.(); }
}
function intent(title = "Review shipping preference") {
  return { schema: "https://github.com/hamanakam1/panther-intent-capture#intent-bundle", schema_version: "1.2", producer: "panther-intent-capture", authority: { export_only: true, requires_review: true, execution_authorized: false }, recording: { id: "surface-capture", title, stated_goal: "Preserve the shipping option", source_url: "https://example.test/settings" }, tickets: [{ id: "proposal-one", title, evidence: "Producer reports one Save click. Persisted value is unknown.", hypothesis: "Save may not persist the option.", steps_to_reproduce: ["Click Save"], suggested_verification_steps: ["Check the saved value after reload"], acceptance_criteria: [], questions: [], status: "draft", requires_review: true, execution_authorized: false }] };
}
async function surface(adapters: Adapter[] = []) {
  const p = new Panther({ store: Store.memory(), adapters, reasoner: new LocalReasoner(), threshold: .25, followMinutes: 25, insightTtlMinutes: 45 });
  const controller = new CompanionController(p);
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element(match[1]);
    for (const attribute of match[0].matchAll(/\b(data-[\w-]+)(?:="([^"]*)")?/g)) el.attributes[attribute[1]] = attribute[2] ?? "";
    el.hidden = /\bhidden\b/.test(match[0]); el.disabled = /\bdisabled\b/.test(match[0]);
    el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    elements.set(el.id, el);
  }
  const $ = (id: string) => { const el = elements.get(id); assert.ok(el, `Element ${id} exists in the shipped HTML`); return el; };
  $("evidence-kind").value = "note";
  const calls: { action: string; data: any }[] = [];
  let interceptor: ((action: string, data: any) => unknown) | null = null;
  const context = createContext({
    window: { pantherAPI: { action: (action: string, data: any) => { calls.push({action,data}); return interceptor ? interceptor(action, data) : controller.action(action, data); } } },
    document: {
      getElementById: $,
      createElement: () => new Element(),
      querySelector: (selector: string) => selector === "dialog[open]" ? [...elements.values()].find(el => el.open) ?? null : null,
      querySelectorAll: (selector: string) => [...elements.values()].filter(el => selector.split(",").some(part => part.startsWith("#") ? el.id === part.slice(1) : part.startsWith("[data-") && Object.hasOwn(el.attributes, part.slice(1,-1)))),
      addEventListener() {},
    },
    TextEncoder, Date, URL, Blob, AbortSignal,
    setTimeout: () => 0, clearTimeout() {}, setInterval() {},
  });
  runInContext(script, context);
  await flush();
  return { $, p, controller, calls, run: (code: string) => runInContext(code, context), intercept: (handler: typeof interceptor) => { interceptor=handler; }, close: () => p.store.close() };
}
async function setGoal(ui: Awaited<ReturnType<typeof surface>>, goal = "Keep my existing goal") {
  ui.$("edit-goal").click(); ui.$("goal-input").value=goal;
  await ui.$("goal-form").onsubmit!({preventDefault(){}});
}
function paste(ui: Awaited<ReturnType<typeof surface>>, value: unknown) {
  ui.$("import").click(); ui.$("bundle-source-paste").click(); ui.$("bundle-text").value=JSON.stringify(value); ui.$("bundle-text").oninput!();
}

describe("Companion first-use and import surface", () => {
  it("keeps Follow disabled while nothing can observe, and enables it the moment a source is configured", async () => {
    const dir=mkdtempSync(join(tmpdir(),"panther-surface-src-"));const path=join(dir,"terminal.jsonl");writeFileSync(path,"");
    try{
      const dark=await surface(); try{await setGoal(dark);assert.equal(dark.$("follow").disabled,true);assert.match(dark.$("follow-help").textContent,/Follow needs a capture source/);assert.equal(dark.controller.status().observable.length,0);}finally{dark.close();}
      const lit=await surface([new TerminalAdapter(path)]); try{await setGoal(lit);assert.equal(lit.$("follow").disabled,false);assert.match(lit.$("follow-help").textContent,/Configured sources have not been checked/);}finally{lit.close();}
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("guides goal → evidence → next check, and explains retained evidence after dismissal", async () => {
    const ui=await surface(); try {
      assert.equal(ui.$("guide-action").textContent,"Set your goal");
      assert.equal(ui.$("follow").disabled,true);
      assert.match(ui.$("follow-help").textContent,/scripts\/capture-command\.sh/,"the surface names the producer instead of leaving Follow a silent dead end");
      await setGoal(ui); assert.equal(ui.$("guide-action").textContent,"Attach evidence");
      ui.$("attach").click(); ui.$("evidence-input").value="The page shows a saved badge.\nNext useful check: Reload and inspect the selected value.";
      await ui.$("evidence-form").onsubmit!({preventDefault(){}});
      assert.equal(ui.$("guide-action").textContent,"Read the next check");
      ui.$("guide-action").click(); assert.equal(ui.$("next-check").focused,true);
      await ui.$("dismiss").click();
      assert.equal(ui.$("guide-action").textContent,"Explain selected evidence");
      assert.equal(ui.$("empty-title").textContent,"Context is ready to explain.");
      await setGoal(ui,"A separate task"); assert.equal(ui.$("context-count").textContent,"No evidence yet");
      assert.equal(ui.$("guide-action").textContent,"Attach evidence");
    } finally {ui.close();}
  });
  it("previews pasted JSON without persistence, then imports only on confirmation and keeps the goal", async () => {
    const ui=await surface(); try {
      await setGoal(ui); paste(ui,intent());
      assert.equal(ui.$("confirm-import").disabled,true);
      await ui.$("preview-bundle").click();
      assert.equal(ui.p.store.latestObservations().length,0);
      assert.equal(ui.$("use-goal").checked,false);
      assert.match(ui.$("bundle-summary").textContent,/1 proposal/);
      assert.match(ui.$("bundle-proposals").textContent,/Producer-reported evidence: Producer reports one Save click/);
      assert.equal(ui.$("confirm-import").textContent,"Import 1 proposal");
      await ui.$("confirm-import").click();
      assert.equal(ui.p.store.latestObservations().length,1);
      assert.equal(ui.controller.status().goal.hypothesis,"Keep my existing goal");
      assert.equal(ui.$("import-dialog").open,false);
      assert.match(ui.$("notice").textContent,/Your goal is unchanged/);
    } finally {ui.close();}
  });
  it("file input uses the same preview and keeps captured-goal adoption explicit", async () => {
    const ui=await surface(); try {
      await setGoal(ui); const raw=JSON.stringify(intent());
      ui.$("import").click(); ui.$("bundle-file").files=[{size:raw.length,text:async()=>raw}]; ui.$("bundle-file").onchange!();
      assert.equal(ui.calls.filter(call=>call.action==="import-preview").length,0);
      await ui.$("preview-bundle").click(); assert.equal(ui.$("use-goal").checked,false);
      ui.$("use-goal").checked=true; await ui.$("confirm-import").click();
      assert.equal(ui.controller.status().goal.hypothesis,"Preserve the shipping option");
      assert.equal(ui.p.store.latestObservations().length,1);
    } finally {ui.close();}
  });
  it("source edits, switches and closing revoke the prior preview and goal choice", async () => {
    const ui=await surface(); try {
      paste(ui,intent()); await ui.$("preview-bundle").click(); ui.$("use-goal").checked=true;
      ui.$("bundle-text").value+=" "; ui.$("bundle-text").oninput!();
      assert.equal(ui.$("confirm-import").disabled,true); assert.equal(ui.$("use-goal").checked,false);
      await ui.$("preview-bundle").click(); ui.$("use-goal").checked=true; ui.$("bundle-source-file").click();
      assert.equal(ui.$("confirm-import").disabled,true); assert.equal(ui.$("use-goal").checked,false);
      ui.$("import-dialog").close(); ui.$("import").click();
      assert.equal(ui.$("confirm-import").disabled,true); assert.equal(ui.$("import-preview").hidden,true);
      assert.equal(ui.p.store.latestObservations().length,0);
    } finally {ui.close();}
  });
  it("a goal change in another host invalidates the open preview and its goal consent", async () => {
    const ui=await surface(); try {
      await setGoal(ui); paste(ui,intent()); await ui.$("preview-bundle").click(); ui.$("use-goal").checked=true;
      await ui.controller.action("goal",{hypothesis:"Another host changed the goal"}); await ui.run("refresh()");
      assert.equal(ui.$("confirm-import").disabled,true); assert.equal(ui.$("use-goal").checked,false);
      assert.match(ui.$("preview-status").textContent,/current goal changed.*Preview/);
      assert.equal(ui.p.store.latestObservations().length,0);
      await ui.$("preview-bundle").click();
      assert.match(ui.$("bundle-current-goal").textContent,/Another host changed the goal/);
    } finally {ui.close();}
  });
  it("an older async preview cannot replace newer input or its explicit goal choice", async () => {
    const ui=await surface(); try {
      let release!: (value: unknown) => void;
      ui.intercept((action,data)=>action==="import-preview" && data.bundle.recording.title==="Old capture" ? new Promise(resolve=>{release=resolve;}) : ui.controller.action(action,data));
      const old=intent("Old capture"); paste(ui,old); const pending=ui.$("preview-bundle").click(); await flush();
      ui.$("bundle-text").value=JSON.stringify(intent("New capture")); ui.$("bundle-text").oninput!();
      await ui.$("preview-bundle").click(); ui.$("use-goal").checked=true;
      release(await ui.controller.action("import-preview",{bundle:old})); await pending;
      assert.match(ui.$("bundle-summary").textContent,/New capture/); assert.equal(ui.$("use-goal").checked,true);
      await ui.$("confirm-import").click(); assert.equal(ui.p.store.latestObservations()[0].label,"New capture");
    } finally {ui.close();}
  });
  it("a late file read cannot revive a closed dialog or supersede a reopened pasted bundle", async () => {
    const ui=await surface(); try {
      let release!: (value: string) => void;
      ui.$("import").click(); ui.$("bundle-file").files=[{size:100,text:()=>new Promise(resolve=>{release=resolve;})}];
      const pending=ui.$("preview-bundle").click();
      ui.$("import-dialog").close(); paste(ui,intent("Current pasted capture")); await ui.$("preview-bundle").click();
      release(JSON.stringify(intent("Late file"))); await pending;
      assert.match(ui.$("bundle-summary").textContent,/Current pasted capture/);
      assert.equal(ui.calls.filter(call=>call.action==="import-preview").length,1);
    } finally {ui.close();}
  });
  it("invalid, oversized, unauthorized and empty bundles explain recovery and cannot import", async () => {
    const ui=await surface(); try {
      paste(ui,intent()); ui.$("bundle-text").value="{broken"; ui.$("bundle-text").oninput!(); await ui.$("preview-bundle").click();
      assert.match(ui.$("notice").textContent,/not valid JSON.*full exported intent bundle/);
      ui.$("bundle-text").value="é".repeat(600000); ui.$("bundle-text").oninput!(); await ui.$("preview-bundle").click();
      assert.match(ui.$("notice").textContent,/too large.*fewer proposals/);
      const invalid=intent(); invalid.authority.execution_authorized=true;
      ui.$("bundle-text").value=JSON.stringify(invalid); ui.$("bundle-text").oninput!(); await ui.$("preview-bundle").click();
      assert.match(ui.$("notice").textContent,/review-only.*Export a new intent bundle/);
      const empty=intent(); empty.tickets=[]; ui.$("bundle-text").value=JSON.stringify(empty); ui.$("bundle-text").oninput!(); await ui.$("preview-bundle").click();
      assert.match(ui.$("preview-status").textContent,/no proposals.*Review drafts/);
      assert.equal(ui.$("confirm-import").disabled,true); assert.equal(ui.p.store.latestObservations().length,0);
      assert.equal(ui.calls.filter(call=>call.action==="import").length,0);
    } finally {ui.close();}
  });
  it("pause permits a safe preview but disables import, and reconnect clears the offline recovery state", async () => {
    const ui=await surface(); try {
      await ui.$("pause").click(); assert.equal(ui.$("guide-action").textContent,"Resume Companion");
      paste(ui,intent()); await ui.$("preview-bundle").click(); assert.equal(ui.$("confirm-import").disabled,true);
      assert.match(ui.$("import-state").textContent,/paused.*Resume/);
      assert.equal(ui.$("import-state").hidden,false);
      assert.equal(ui.$("confirm-import").textContent,"Resume Companion to import");
      ui.$("import-dialog").close(); await ui.$("pause").click();
      ui.intercept(()=>Promise.reject(new Error("offline"))); await ui.run("refresh()");
      assert.equal(ui.$("connection-notice").hidden,false); assert.equal(ui.$("attach").disabled,true);
      ui.intercept(null); await ui.$("retry").click();
      assert.equal(ui.$("connection-notice").hidden,true); assert.equal(ui.$("attach").disabled,false);
    } finally {ui.close();}
  });
  it("guides a new default producer through Explain again before enabling Follow without status probes",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-default-surface-")), oldHome=process.env.PANTHER_HOME, oldLog=process.env.PANTHER_TERMINAL_LOG;
    process.env.PANTHER_HOME=dir; delete process.env.PANTHER_TERMINAL_LOG;
    const ui=await surface([new TerminalAdapter()]);
    try {
      await setGoal(ui); assert.equal(ui.$("follow").disabled,true);
      assert.match(ui.$("follow-help").textContent,/capture-command\.sh.*Explain again to check/);
      writeFileSync(join(dir,"terminal.jsonl"),'{"command":"npm test","exitCode":1,"stderr":"Synthetic failure"}\n');
      await ui.run("refresh()"); assert.equal(ui.$("follow").disabled,true);
      await ui.$("explain").click(); assert.equal(ui.$("follow").disabled,false);
      assert.match(ui.$("sources").textContent,/1 record received/);
      assert.equal(ui.$("app-version").textContent,"v"+ui.controller.status().version);
    } finally {
      ui.close();if(oldHome===undefined)delete process.env.PANTHER_HOME;else process.env.PANTHER_HOME=oldHome;
      if(oldLog===undefined)delete process.env.PANTHER_TERMINAL_LOG;else process.env.PANTHER_TERMINAL_LOG=oldLog;rmSync(dir,{recursive:true,force:true});
    }
  });
  it("shows unavailable Follow honestly, keeps manual actions available, and recovers after a real read", async () => {
    const dir=mkdtempSync(join(tmpdir(),"panther-surface-source-")), path=join(dir,"sensitive-path.jsonl");
    const ui=await surface([new TerminalAdapter(path)]); try {
      await setGoal(ui); assert.match(ui.$("sources").textContent,/not checked in this process/);
      await ui.$("follow").click();
      assert.equal(ui.$("status-text").textContent,"Source needs attention");
      assert.equal(ui.$("connection-status").dataset.tone,"warning");
      assert.equal(ui.$("session-bar").dataset.tone,"warning");
      assert.match(ui.$("source-warning").textContent,/file not found.*Follow will retry automatically/);
      assert.ok(!ui.$("source-warning").textContent.includes(path));
      assert.equal(ui.$("attach").disabled,false); assert.equal(ui.$("import").disabled,false);
      writeFileSync(path,'{"command":"npm test","exitCode":1,"stderr":"Synthetic failure"}\n');
      await ui.run("refresh()"); assert.equal(ui.$("status-text").textContent,"Source needs attention");
      await ui.controller.tick(); await ui.run("refresh()");
      assert.equal(ui.$("status-text").textContent,"Following"); assert.equal(ui.$("source-warning").hidden,true);
      assert.match(ui.$("sources").textContent,/Last received record:/);
      await ui.controller.tick(); await ui.run("refresh()"); assert.equal(ui.$("status-text").textContent,"Waiting for evidence");
    } finally {ui.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("treats an older host's configured string as unchecked rather than healthy",async()=>{
    const ui=await surface(); try {
      const legacy={...ui.controller.status(),sources:["terminal: configured"],sourceReadiness:undefined,session:{status:"active",endsAt:"2026-10-26T05:00:00Z"}};
      await ui.run("render("+JSON.stringify(legacy)+")");
      assert.equal(ui.$("status-text").textContent,"Waiting for evidence");
      assert.match(ui.$("sources").textContent,/configured; not checked/);
    } finally {ui.close();}
  });
  it("routine successful terminal evidence stays quiet and offers a new result instead of an empty-state loop", async () => {
    const ui=await surface(); try {
      await setGoal(ui); ui.$("attach").click(); ui.$("evidence-kind").value="terminal"; ui.$("evidence-kind").onchange!();
      assert.equal(ui.$("exit-code").value,""); assert.equal(ui.$("exit-code").required,true);
      ui.$("command").value="npm test"; ui.$("exit-code").value="0"; ui.$("evidence-input").value="All tests passed";
      await ui.$("evidence-form").onsubmit!({preventDefault(){}});
      assert.equal(ui.$("guide-action").textContent,"Attach a new result");
      assert.equal(ui.$("empty-title").textContent,"Nothing here needs an interruption.");
      await setGoal(ui,"A different goal with no evidence yet");
      assert.equal(ui.$("empty-title").textContent,"Your next check will appear here.");
      assert.equal(ui.$("guide-action").textContent,"Attach evidence");
    } finally {ui.close();}
  });
});
