import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../src/state/store.js";
import { Panther } from "../src/ingest.js";
import { LocalReasoner, type Reasoner } from "../src/core/reasoner.js";
import { CompanionController } from "../src/controller.js";
import { VERSION } from "../src/version.js";
import { parseIntentBundle } from "../src/bundle.js";
import { createCompanionServer } from "../src/http.js";
import { JsonlCursor } from "../src/adapters/jsonl.js";
import { TerminalAdapter } from "../src/adapters/terminal.js";
import { companionBounds } from "../src/electron/layout.js";
import { isLoopbackUrl, normalizeConfig } from "../src/config.js";
import type { Adapter } from "../src/adapters/adapter.js";
import type { Observation, ReasonerOutput } from "../src/domain.js";

const NOW = "2026-10-24T12:00:00.000Z";
function make(reasoner: Reasoner = new LocalReasoner(), adapters: Adapter[] = []) {
  const p = new Panther({ store: Store.memory(), adapters, reasoner, threshold: .25, followMinutes: 25, insightTtlMinutes: 45 });
  return { p, c: new CompanionController(p, () => NOW) };
}
const failure: Observation = { id: "one", providerId: "terminal", capturedAt: NOW, label: "npm test", locator: "selected", summary: "npm test failed", payload: { command: "npm test", exitCode: 1, stderr: "Cannot find module" }, signature: "failure-one" };
function bundle() { return { schema: "https://github.com/hamanakam1/panther-intent-capture#intent-bundle", schema_version: "1.2", producer: "panther-intent-capture", authority: { export_only: true, requires_review: true, execution_authorized: false }, recording: { id: "capture-one", title: "Example capture", stated_goal: "Make checkout reliable", source_url: "https://example.test/checkout" }, tickets: [{ id: "draft-one", title: "Review checkout", evidence: "The producer reports three clicks", hypothesis: "The control may be stuck", steps_to_reproduce: ["Click Save"], suggested_verification_steps: ["Check whether Save submits once"], acceptance_criteria: ["Save submits once"], questions: [], status: "draft", requires_review: true, execution_authorized: false }] }; }

/** A configured source for tests whose subject is the session, not the honesty guard. */
const followable = () => new TerminalAdapter(join(tmpdir(), "panther-configured-source.jsonl"));

describe("Companion MVP lifecycle", () => {
  it("reports one version from package.json through status, MCP and the surface",()=>{
    const {p,c}=make();try{
      const shipped=(JSON.parse(readFileSync(new URL("../../package.json",import.meta.url),"utf8")) as {version:string}).version;
      assert.match(shipped,/^\d+\.\d+\.\d+$/);
      assert.equal(VERSION,shipped,"src/version.ts drifted from package.json; run npm run build");
      assert.equal(c.status().version,VERSION);
      assert.match(readFileSync(new URL("../../surface/card.html",import.meta.url),"utf8"),/id="app-version"/,"surface no longer renders the version");
    }finally{p.store.close();}
  });
  it("persists explanations through status and refreshes repeated evidence without duplicate insights", async () => {
    const {p,c}=make();
    try {
      const first=await p.ingestObservations([failure],{onRequest:true,now:NOW});
      assert.equal(c.status().live?.insightId,first.live?.insightId);
      const again=await p.ingestObservations([failure],{onRequest:true,now:NOW});
      assert.equal(again.live?.insightId,first.live?.insightId);
      assert.equal(p.store.countInsights().transient,1);
      assert.equal((p.exportAll().observations as unknown[]).length,1);
    } finally {p.store.close();}
  });
  it("Explain can use previously attached evidence when adapters have nothing new",async()=>{
    const {p,c}=make();try{await c.action("observation",{kind:"terminal",command:"npm test",exitCode:1,text:"Cannot find module"});await c.action("dismiss");await c.action("explain");assert.equal(c.status().live?.explanation.topic,"command-failure");}finally{p.store.close();}
  });
  it("changing the goal clears stale card and ends the follow session",async()=>{
    const {p,c}=make(new LocalReasoner(),[followable()]);try{await c.action("goal",{hypothesis:"Fix npm test"});await c.action("follow");await p.ingestObservations([failure],{onRequest:true,now:NOW});await c.action("goal",{hypothesis:"Improve checkout"});assert.equal(c.status().live,null);assert.equal(c.status().session,null);assert.equal(c.status().questions.length,0);}finally{p.store.close();}
  });
  it("a new goal does not inherit the previous task evidence or explanations",async()=>{
    const {p,c}=make();try{await c.action("goal",{hypothesis:"Project A build"});await c.action("observation",{kind:"terminal",command:"npm run build",exitCode:1,text:"Build failed"});await c.action("goal",{hypothesis:"Project B typography"});assert.equal(p.store.latestObservations().length,0);assert.equal(p.store.recentSummaries(10).length,0);await c.action("explain");assert.equal(c.status().live?.explanation.topic,"empty-capture");assert.equal((p.exportAll().observations as unknown[]).length,1);}finally{p.store.close();}
  });
  it("prepare produces a decision brief without leaving a follow session active",async()=>{
    const {p,c}=make();try{await c.action("goal",{hypothesis:"Compare captured workflow"});await c.action("import",{bundle:bundle(),useGoal:false});await c.action("prepare");assert.equal(c.status().live?.producedBy,"prepare");assert.equal(c.status().live?.explanation.topic,"decision-brief");assert.equal(c.status().session?.status,"ended");}finally{p.store.close();}
  });
  it("pause stops evidence before storage and requires real booleans",async()=>{
    const {p,c}=make();try{await assert.rejects(c.action("pause",{paused:"false"}),/boolean/);await c.action("pause",{paused:true});await assert.rejects(c.action("observation",{text:"private note"}),/Resume/);assert.equal((p.exportAll().observations as unknown[]).length,0);}finally{p.store.close();}
  });
  for(const action of ["pause","goal","delete"]){it(`late reasoning cannot republish after ${action}`,async()=>{
    let finish!: (output:ReasonerOutput)=>void;
    const {p,c}=make({id:"delayed",reason:()=>new Promise(resolve=>{finish=resolve;})});
    try{const pending=p.ingestObservations([failure],{onRequest:true,now:NOW});await c.action(action,action==="pause"?{paused:true}:action==="goal"?{hypothesis:"New task"}:{confirm:"DELETE"});finish(await new LocalReasoner().reason({goal:p.store.getGoal(NOW),observations:[failure],openQuestions:[],recentSummaries:[],depthByTopic:{},now:NOW,brief:false,returnToTask:false}));const result=await pending;assert.equal(result.live,null);assert.equal(c.status().live,null);assert.equal(p.store.listGateLogs(10).length,0);if(action==="delete")assert.equal((p.exportAll().observations as unknown[]).length,0);}finally{p.store.close();}
  });}
  it("persisted state revisions fence delayed work from another host, including pause/resume",async()=>{
    let finish!: (output:ReasonerOutput)=>void;
    const {p}=make({id:"delayed",reason:()=>new Promise(resolve=>{finish=resolve;})});
    const other=new Panther({store:p.store,adapters:[],reasoner:new LocalReasoner(),threshold:.25,followMinutes:25,insightTtlMinutes:45});
    const c=new CompanionController(other,()=>NOW);
    try{p.setGoal("Goal A",NOW);const pending=p.ingestObservations([failure],{onRequest:true,now:NOW});await c.action("pause",{paused:true});await c.action("pause",{paused:false});finish(await new LocalReasoner().reason({goal:p.store.getGoal(NOW),observations:[failure],openQuestions:[],recentSummaries:[],depthByTopic:{},now:NOW,brief:false,returnToTask:false}));assert.equal((await pending).live,null);assert.equal(c.status().live,null);const second=p.ingestObservations([failure],{onRequest:true,now:NOW});other.setGoal("Goal B",NOW);finish(await new LocalReasoner().reason({goal:p.store.getGoal(NOW),observations:[failure],openQuestions:[],recentSummaries:[],depthByTopic:{},now:NOW,brief:false,returnToTask:false}));assert.equal((await second).live,null);assert.equal(c.status().goal.hypothesis,"Goal B");}finally{p.store.close();}
  });
  it("state and revision change atomically for a second SQLite connection",()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-atomic-"));const path=join(dir,"state.sqlite");const first=Store.open(path);first.getGoal(NOW);const second=Store.open(path);const before=second.goalState(NOW);
    try{first.transaction(()=>{first.saveGoal({...before.goal,id:"new-goal",hypothesis:"Changed"});assert.deepEqual(second.goalState(NOW),before);});const after=second.goalState(NOW);assert.equal(after.goal.hypothesis,"Changed");assert.notEqual(after.revision,before.revision);}finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("expired card is removed from status",async()=>{
    const {p}=make();try{await p.ingestObservations([failure],{onRequest:true,now:NOW});const c=new CompanionController(p,()=>"2026-10-24T13:00:00.000Z");assert.equal(c.status().live,null);}finally{p.store.close();}
  });
  it("feedback changes preferences and Wrong task clears the explanation",async()=>{
    const {p,c}=make();try{await p.ingestObservations([failure],{onRequest:true,now:NOW});await c.action("feedback",{kind:"ExplainMechanism"});assert.equal(p.store.getPreferences().depthByTopic["command-failure"],"mechanism");await c.action("feedback",{kind:"AlreadyKnow"});assert.ok(p.store.getPreferences().knownSignatures.includes(failure.signature));await c.action("feedback",{kind:"WrongTask"});assert.equal(c.status().live,null);assert.equal(c.status().goal.needsCorrection,true);}finally{p.store.close();}
  });
  it("startup does not resume an active follow session",async()=>{
    const {p,c}=make(new LocalReasoner(),[followable()]);try{await c.action("goal",{hypothesis:"Fix tests"});await c.action("follow");const restarted=new CompanionController(p,()=>NOW);assert.equal(restarted.status().session?.status,"paused");}finally{p.store.close();}
  });
  it("follow ends at its deadline",async()=>{
    const {p,c}=make(new LocalReasoner(),[followable()]);try{await c.action("goal",{hypothesis:"Fix tests"});await c.action("follow");const later=new CompanionController(p,()=>NOW);p.store.saveSession({...p.store.getSession()!,status:"active",endsAt:NOW});assert.equal(later.status().session?.status,"ended");}finally{p.store.close();}
  });
  it("delete needs explicit exact confirmation",async()=>{
    const {p,c}=make();try{p.store.insertObservation(failure);await assert.rejects(c.action("delete",{confirm:true}),/DELETE/);assert.equal(p.store.latestObservations().length,1);await c.action("delete",{confirm:"DELETE"});assert.equal(p.store.latestObservations().length,0);}finally{p.store.close();}
  });
});

describe("Intent Capture interoperability",()=>{
  it("imports review proposals without adopting their goal unless explicitly requested",async()=>{
    const {p,c}=make();try{await c.action("goal",{hypothesis:"Existing goal"});await c.action("import",{bundle:bundle(),useGoal:false});assert.equal(c.status().goal.hypothesis,"Existing goal");const e=c.status().live!.explanation;assert.equal(e.topic,"captured-intent");assert.ok(e.observed.every(line=>line.includes("not independently verified")));assert.ok(e.inferred[0].includes("Unverified"));assert.ok(e.nextCheck.includes("not yet performed"));assert.equal((p.store.latestObservations()[0].payload as Record<string,unknown>).executionAuthorized,false);await c.action("import",{bundle:bundle(),useGoal:true});assert.equal(c.status().goal.hypothesis,"Make checkout reliable");assert.equal(p.store.latestObservations().length,1);}finally{p.store.close();}
  });
  it("explicit reuse under a new goal preserves the previous explanation history",async()=>{
    const{p,c}=make();try{await c.action("goal",{hypothesis:"First task"});await c.action("import",{bundle:bundle(),useGoal:false});const old=c.status().live!;await c.action("goal",{hypothesis:"Second task"});await c.action("import",{bundle:bundle(),useGoal:false});assert.notEqual(c.status().live?.insightId,old.insightId);assert.ok(p.store.getExplanation(old.explanation.id)?.whyItMattersHere.includes("First task"));assert.equal(p.store.countInsights().transient,2);}finally{p.store.close();}
  });
  it("identical imports retain stable evidence identity; edited proposals get a new revision",()=>{const original=bundle();const a=parseIntentBundle(original,NOW);assert.equal(a.observations[0].id,parseIntentBundle(original,"later").observations[0].id);original.tickets[0].hypothesis="Different possibility";assert.notEqual(a.observations[0].id,parseIntentBundle(original,NOW).observations[0].id);});
  it("rejects authority strings and elevated authority at both levels",()=>{for(const value of [true,"false",0,null]){const input:any=bundle();input.authority.execution_authorized=value;assert.throws(()=>parseIntentBundle(input,NOW),/authority/);const second:any=bundle();second.tickets[0].execution_authorized=value;assert.throws(()=>parseIntentBundle(second,NOW),/authority/);}});
  it("rejects invalid producer, version, identifiers, credentials, duplicate IDs and oversized fields",()=>{
    const bad: any[]=[];
    let b:any=bundle();b.producer="unknown";bad.push(b);b=bundle();b.schema_version="9";bad.push(b);b=bundle();b.recording.id="../../private";bad.push(b);b=bundle();b.recording.source_url="https://secret:password@example.test/";bad.push(b);b=bundle();b.tickets.push(b.tickets[0]);bad.push(b);b=bundle();b.tickets[0].evidence="x".repeat(6001);bad.push(b);for(const item of bad)assert.throws(()=>parseIntentBundle(item,NOW));
  });
  it("discards raw payloads and media while preserving supported projection",()=>{const b:any=bundle();b.private_blob="private";b.tickets[0].rawScreenshot="secret pixels";const result=parseIntentBundle(b,NOW);assert.ok(!JSON.stringify(result).includes("secret pixels"));assert.ok(!JSON.stringify(result).includes("private_blob"));});
  it("empty exports are valid and do not fabricate observations",async()=>{const{p,c}=make();try{const b=bundle();b.tickets=[];await c.action("import",{bundle:b,useGoal:false});assert.equal(p.store.latestObservations().length,0);assert.equal(c.status().live,null);}finally{p.store.close();}});
});

describe("local HTTP boundary",()=>{
  it("serves the surface, handles goal/evidence/status, rejects other origins and hostile hosts",async()=>{
    const{p,c}=make();const server=createCompanionServer(c);server.listen(0,"127.0.0.1");await once(server,"listening");const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try{const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/id="context-details"/);assert.equal(page.headers.get("access-control-allow-origin"),null);
      assert.equal(await new Promise(resolve=>{get(url,{headers:{"sec-fetch-site":"cross-site","sec-fetch-mode":"navigate","sec-fetch-dest":"document"}},response=>{response.resume();resolve(response.statusCode);});}),200);
      assert.equal((await fetch(url+"/api/status",{headers:{"sec-fetch-site":"cross-site","sec-fetch-mode":"navigate","sec-fetch-dest":"document"}})).status,403);
      const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
      assert.equal((await post("/api/goal",{hypothesis:"Fix tests"})).status,200);
      const attached=await post("/api/observation",{kind:"terminal",command:"npm test",exitCode:1,text:"Missing module"});assert.equal(attached.status,200);assert.equal((await attached.json()).busy,false);
      assert.equal((await (await fetch(url+"/api/status")).json()).live.explanation.topic,"command-failure");
      assert.equal((await post("/api/delete",{confirm:"DELETE"},{origin:"https://evil.test"})).status,403);
      assert.equal(await new Promise(resolve=>{get(url+"/api/export",{headers:{host:"evil.test"}},response=>{response.resume();resolve(response.statusCode);});}),403);
      assert.equal((await post("/api/pause",{paused:"false"})).status,400);
      assert.equal((await fetch(url+"/api/goal",{method:"POST",headers:{"content-type":"application/json"},body:"{"})).status,400);
      assert.equal((await fetch(url+"/api/goal",{method:"POST",headers:{"content-type":"application/json"},body:'"'+"x".repeat(1024*1024)+'"'})).status,400);
      assert.equal(c.status().goal.hypothesis,"Fix tests");
    }finally{server.close();server.closeAllConnections();await once(server,"close");p.store.close();}
  });
});

describe("configured follow sources",()=>{
  it("consumes JSONL once, holds partial lines, ignores malformed/nonobjects, handles truncation",()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-jsonl-"));const path=join(dir,"events.jsonl");const cursor=new JsonlCursor();
    try{writeFileSync(path,'{"command":"first"}\nnull\n[]\nbroken\n{"command":');assert.equal(cursor.read(path).length,1);assert.equal(cursor.read(path).length,0);appendFileSync(path,'"second"}\n');assert.equal(cursor.read(path)[0].command,"second");writeFileSync(path,'{}\n');assert.equal(cursor.read(path).length,1);}finally{rmSync(dir,{recursive:true,force:true});}
  });
  it("captures more than 25 source rows without losing newest failures",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-batch-"));const path=join(dir,"events.jsonl");writeFileSync(path,Array.from({length:30},(_,i)=>JSON.stringify({command:"npm test "+i,exitCode:i===29?1:0,stderr:i===29?"Last event failed":""})).join("\n")+"\n");const p=new Panther({store:Store.memory(),adapters:[new TerminalAdapter(path)],reasoner:new LocalReasoner(),threshold:.1,followMinutes:25,insightTtlMinutes:45});
    try{const result=await p.explain();assert.equal(result.storedObservationIds.length,30);assert.equal((p.exportAll().observations as unknown[]).length,30);assert.ok(result.live?.explanation.whatItMeans.includes("29"));await p.ingest({});assert.equal((p.exportAll().observations as unknown[]).length,30);}finally{p.store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("bounded follow reads new terminal evidence and pause prevents further reads",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-follow-"));const path=join(dir,"events.jsonl");writeFileSync(path,"");const p=new Panther({store:Store.memory(),adapters:[new TerminalAdapter(path)],reasoner:new LocalReasoner(),threshold:.1,followMinutes:25,insightTtlMinutes:45});const c=new CompanionController(p);
    try{await c.action("goal",{hypothesis:"Fix npm test"});await c.action("follow");appendFileSync(path,JSON.stringify({command:"npm test",exitCode:1,stderr:"Missing module"})+"\n");await c.tick();assert.equal(c.status().live?.explanation.topic,"command-failure");await c.tick();assert.equal(p.store.latestObservations().length,1);await c.action("pause",{paused:true});appendFileSync(path,JSON.stringify({command:"npm run build",exitCode:1,stderr:"New error"})+"\n");await c.tick();assert.equal(p.store.latestObservations().length,1);}finally{p.store.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("refuses follow out loud when no source can observe, instead of watching an empty room",async()=>{
    const p=new Panther({store:Store.memory(),adapters:[new TerminalAdapter(null)],reasoner:new LocalReasoner(),threshold:.1,followMinutes:25,insightTtlMinutes:45});const c=new CompanionController(p,()=>NOW);
    try{
      assert.deepEqual(p.observableSources(),[]);
      assert.deepEqual(c.status().observable,[],"status must not claim an observable source it does not have");
      await c.action("goal",{hypothesis:"Fix npm test"});
      await assert.rejects(()=>c.action("follow"),(err:Error)=>/No capture source is configured/.test(err.message)&&/capture-command\.sh/.test(err.message));
      assert.equal(c.status().session,null,"a refused follow must not open a session");
    }finally{p.store.close();}
  });
  it("counts a configured source as observable and keeps the shared default dark until it exists",()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-observe-"));
    const previous=process.env.PANTHER_HOME;process.env.PANTHER_HOME=dir;
    try{
      const adapter=new TerminalAdapter();
      assert.equal(adapter.supports(),false,"the default file does not exist yet, so nothing is observable");
      writeFileSync(join(dir,"terminal.jsonl"),"");
      assert.equal(adapter.supports(),true,"the producer created the shared file, so the source is now live");
      const p=new Panther({store:Store.memory(),adapters:[adapter,new TerminalAdapter(null)],reasoner:new LocalReasoner(),threshold:.1,followMinutes:25,insightTtlMinutes:45});
      try{assert.deepEqual(p.observableSources(),["terminal"]);assert.deepEqual(p.sources(),["terminal: configured","terminal: not configured"]);}finally{p.store.close();}
    }finally{if(previous===undefined)delete process.env.PANTHER_HOME;else process.env.PANTHER_HOME=previous;rmSync(dir,{recursive:true,force:true});}
  });
  it("turns a real wrapped command failure into a follow card through the shared producer",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-producer-"));
    const previousHome=process.env.PANTHER_HOME, previousLog=process.env.PANTHER_TERMINAL_LOG;
    process.env.PANTHER_HOME=dir;delete process.env.PANTHER_TERMINAL_LOG;
    try{
      await new Promise<void>((resolve,reject)=>{
        execFile("bash",[new URL("../../scripts/capture-command.sh",import.meta.url).pathname,"bash","-c","echo boom >&2; exit 3"],{env:{...process.env,PANTHER_HOME:dir}},(error)=>error&&(error as {code?:number}).code===3?resolve():reject(error??new Error("expected exit 3")));
      });
      const p=new Panther({store:Store.memory(),adapters:[new TerminalAdapter()],reasoner:new LocalReasoner(),threshold:.1,followMinutes:25,insightTtlMinutes:45});const c=new CompanionController(p,()=>NOW);
      try{
        assert.deepEqual(c.status().observable,["terminal"]);
        await c.action("goal",{hypothesis:"Fix the failing command"});
        await c.action("follow");
        await c.tick();
        assert.equal(c.status().live?.explanation.topic,"command-failure");
        assert.match(JSON.stringify(c.status().live?.explanation),/boom/);
      }finally{p.store.close();}
    }finally{
      if(previousHome===undefined)delete process.env.PANTHER_HOME;else process.env.PANTHER_HOME=previousHome;
      if(previousLog===undefined)delete process.env.PANTHER_TERMINAL_LOG;else process.env.PANTHER_TERMINAL_LOG=previousLog;
      rmSync(dir,{recursive:true,force:true});
    }
  });
});

describe("desktop layout and local inference",()=>{
  it("uses largest secondary display with negative origin and menu insets",()=>{assert.deepEqual(companionBounds([{id:1,workArea:{x:0,y:30,width:1728,height:1080}},{id:2,workArea:{x:-3440,y:-200,width:3440,height:1410}}],1),{x:-700,y:-200,width:700,height:1410});});
  it("rejects remote, credentialed and non-http model URLs",()=>{for(const url of ["https://cloud.test/api/generate","file:///private/key","http://user:pass@127.0.0.1/","http://127.0.0.1.evil.test/"])assert.equal(isLoopbackUrl(url),false);assert.equal(isLoopbackUrl("http://127.0.0.1:11434/api/generate"),true);assert.equal(isLoopbackUrl("http://[::1]:11434/api/generate"),true);assert.equal(normalizeConfig({reasoning:{ollamaUrl:"https://cloud.test"}}).reasoning.ollamaUrl,"http://127.0.0.1:11434/api/generate");});
});
