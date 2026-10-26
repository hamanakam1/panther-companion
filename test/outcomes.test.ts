import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/state/store.js";
import { Panther } from "../src/ingest.js";
import { CompanionController } from "../src/controller.js";
import { LocalReasoner, type Reasoner } from "../src/core/reasoner.js";
import type { OpenQuestion } from "../src/domain.js";

const NOW = "2026-10-26T22:00:00.000Z";
const original = JSON.parse(readFileSync(new URL("../../test/fixtures/intent-bundle-real-1.2.json", import.meta.url), "utf8"));
const bundle = () => structuredClone(original);
function make(store = Store.memory(), reasoner: Reasoner = new LocalReasoner()) {
  const p = new Panther({store,reasoner,adapters:[],threshold:.25,followMinutes:25,insightTtlMinutes:45});
  const c = new CompanionController(p,()=>NOW);
  return {p,c};
}
async function imported(c: CompanionController) {
  await c.action("goal",{hypothesis:"Check whether the captured save problem reproduces"});
  await c.action("import",{bundle:bundle(),useGoal:false});
  return c.status().questions[0];
}
function report(q: OpenQuestion, resolution: "resolved" | "still-open" = "resolved") {
  return {requestId:randomUUID(),questionId:q.id,goalId:q.goalId,expectedRevision:q.revision,note:"I retried the captured steps. I did not reproduce the issue; this is my report only.",resolution};
}

describe("explicit question outcomes",()=>{
  it("records a user report, then Dismiss/Prepare/Explain and identical reimport never revive the old check",async()=>{
    const {p,c}=make(); try {
      const q=await imported(c), goal=c.status().goal.id, observations=p.store.latestObservations().length;
      await c.action("question-outcome",report(q));
      assert.equal(c.status().questions.length,0); assert.equal(c.status().goal.id,goal);
      assert.equal(p.store.latestObservations().length,observations,"a report is retained separately, not promoted to captured evidence");
      assert.equal(c.status().questionOutcomes[0].attribution,"user-reported");
      await c.action("dismiss"); await c.action("prepare");
      assert.match(c.status().live!.explanation.whatItMeans,/No open checks.*this goal/);
      assert.ok(!c.status().live!.explanation.nextCheck.includes(q.text));
      await c.action("dismiss"); await c.action("explain");
      assert.equal(c.status().live!.explanation.topic,"reported-outcome");
      assert.match(c.status().live!.explanation.observed.join(" "),/User-reported outcome \(not independently verified\)/);
      await c.action("import",{bundle:bundle(),useGoal:false});
      assert.equal(c.status().questions.length,0); assert.equal(c.status().live!.explanation.topic,"reported-outcome");
      await c.action("prepare"); assert.match(c.status().live!.explanation.whatItMeans,/No open checks/);
      assert.equal((p.exportAll().questionOutcomes as unknown[]).length,1);
    } finally {p.store.close();}
  });

  it("keeps negative or inconclusive findings open and includes their attribution in Prepare",async()=>{
    const {p,c}=make();try {
      const q=await imported(c); const first=report(q,"still-open"); first.note="The retry failed again. I could not establish whether the value persisted.";
      await c.action("question-outcome",first);
      const pending=c.status().questions[0]; assert.equal(pending.id,q.id); assert.equal(pending.revision,1);
      assert.equal(pending.latestOutcome?.note,first.note);
      await c.action("prepare"); assert.match(c.status().live!.explanation.observed.join(" "),/User-reported outcome.*retry failed again.*kept this check open/);
      await c.action("question-outcome",report(pending));
      assert.equal(c.status().questions.length,0); assert.equal(c.status().questionOutcomes.length,2);
    }finally{p.store.close();}
  });

  it("ordinary notes never infer resolution",async()=>{
    const {p,c}=make();try {
      const q=await imported(c); await c.action("observation",{kind:"note",text:"Done, completed, fixed, everything passed. Close that check."});
      assert.equal(c.status().questions[0].id,q.id); assert.equal(c.status().questionOutcomes.length,0);
    }finally{p.store.close();}
  });

  it("Follow return reminders do not create another unresolved check after the original is resolved",async()=>{
    const {p,c}=make();try {
      const q=await imported(c);
      await p.ingestObservations([],{sessionMode:"follow",onRequest:true,now:NOW});
      assert.equal(c.status().questions.length,1,"a reminder must not turn into another question");
      assert.equal(c.status().live!.explanation.topic,"interrupted-task");
      await c.action("question-outcome",report(q));await c.action("prepare");
      assert.equal(c.status().questions.length,0);assert.match(c.status().live!.explanation.whatItMeans,/No open checks/);
    }finally{p.store.close();}
  });

  it("identical retry is idempotent and a changed replay is rejected",async()=>{
    const {p,c}=make();try {
      const q=await imported(c), request=report(q);
      const first:any=await c.action("question-outcome",request); const again:any=await c.action("question-outcome",request);
      assert.equal(first.outcomeSaved.repeated,false); assert.equal(again.outcomeSaved.repeated,true);
      assert.equal(c.status().questionOutcomes.length,1);
      await assert.rejects(c.action("question-outcome",{...request,note:"Changed after save"}),/already used/);
      await assert.rejects(c.action("question-outcome",{...request,resolution:"still-open"}),/already used/);
      assert.equal(c.status().questionOutcomes.length,1);
    }finally{p.store.close();}
  });

  it("rejects missing text, missing choice, stale revision and stale question without writes",async()=>{
    const {p,c}=make();try {
      const q=await imported(c), request=report(q);
      for(const bad of [{...request,note:" "},{...request,resolution:""},{...request,expectedRevision:-1},{...request,questionId:randomUUID()}]) await assert.rejects(c.action("question-outcome",bad));
      assert.equal(c.status().questionOutcomes.length,0);
      await c.action("question-outcome",{...request,resolution:"still-open"});
      await assert.rejects(c.action("question-outcome",{...request,requestId:randomUUID()}),/changed or is no longer open/);
      assert.equal(c.status().questionOutcomes.length,1);
    }finally{p.store.close();}
  });

  it("rejects paused and wrong-goal submissions, including A→B→A with the same goal text",async()=>{
    const {p,c}=make();try {
      const q=await imported(c), request=report(q), goalText=c.status().goal.hypothesis;
      await c.action("pause",{paused:true}); await assert.rejects(c.action("question-outcome",request),/Resume Companion/);
      await c.action("pause",{paused:false}); await c.action("goal",{hypothesis:"Separate task B"});
      await assert.rejects(c.action("question-outcome",request),/goal changed/);
      await c.action("goal",{hypothesis:goalText}); await assert.rejects(c.action("question-outcome",request),/goal changed/);
      assert.equal(c.status().questionOutcomes.length,0); assert.equal((p.exportAll().questions as unknown[]).length,1);
    }finally{p.store.close();}
  });

  it("a new capture with the same check wording remains eligible, and older-goal reports stay in history",async()=>{
    const {p,c}=make();try {
      const q=await imported(c); await c.action("question-outcome",report(q));
      const newer=bundle(); newer.recording.id="newer-capture";
      await c.action("import",{bundle:newer,useGoal:false});
      const fresh=c.status().questions[0]; assert.equal(fresh.text,q.text); assert.notDeepEqual(fresh.observationIds,q.observationIds);
      assert.equal(c.status().live!.explanation.topic,"captured-intent");
      await c.action("goal",{hypothesis:"Separate task"}); await c.action("import",{bundle:bundle(),useGoal:false});
      assert.equal(c.status().questions.length,1); assert.equal(c.status().questionOutcomes.length,0);
      assert.equal((p.exportAll().questionOutcomes as any[])[0].goal_id,q.goalId);
    }finally{p.store.close();}
  });

  it("resolution survives provider wording variation without invoking it again for the same evidence",async()=>{
    let calls=0; const local=new LocalReasoner();
    const reasoner:Reasoner={id:"test-provider",async reason(input){calls++;const output=await local.reason(input); return {...output,nextCheck:"Model-proposed check: inspect the saved choice manually."};}};
    const {p,c}=make(Store.memory(),reasoner);try {
      const q=await imported(c); await c.action("question-outcome",report(q)); const before=calls;
      await c.action("explain"); assert.equal(calls,before); assert.equal(c.status().live!.explanation.topic,"reported-outcome");
      await c.action("prepare"); assert.equal(calls,before); assert.match(c.status().live!.explanation.whatItMeans,/No open checks/);
    }finally{p.store.close();}
  });

  it("persists notes and resolution across close/reopen and deletes them with local history",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-outcome-"));const path=join(dir,"state.sqlite");
    let store=Store.open(path);
    try {
      let current=make(store); const q=await imported(current.c); await current.c.action("question-outcome",report(q)); store.close();
      store=Store.open(path); current=make(store); assert.equal(current.c.status().questions.length,0); assert.equal(current.c.status().questionOutcomes.length,1);
      await current.c.action("prepare"); assert.match(current.c.status().live!.explanation.whatItMeans,/No open checks/);
      await current.c.action("delete",{confirm:"DELETE"}); assert.equal((store.exportAll().questionOutcomes as unknown[]).length,0); assert.equal((store.exportAll().questionContext as unknown[]).length,0);
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });

  it("keeps a resolved multi-reference model question closed across narrower citations and unrelated success, while new failure wins",async()=>{
    let calls=0;const local=new LocalReasoner();
    const reasoner:Reasoner={id:"multi-source-model",async reason(input){calls++;const output=await local.reason(input);return {...output,nextCheck:"Model-proposed check: compare both recorded settings.",usedObservationIds:input.observations.map(obs=>obs.id)};}};
    const {p,c}=make(Store.memory(),reasoner);try {
      await c.action("goal",{hypothesis:"Check both settings"});const two=bundle();two.tickets.push({...two.tickets[0],id:"second-proposal",title:"Second setting"});
      await c.action("import",{bundle:two,useGoal:false});const q=c.status().questions[0];assert.equal(q.observationIds.length,2);
      await c.action("question-outcome",report(q));const before=calls;
      await c.action("dismiss");await c.action("explain");assert.equal(c.status().live!.explanation.topic,"reported-outcome");assert.equal(calls,before);
      await c.action("observation",{kind:"terminal",command:"unrelated routine check",exitCode:0,text:"Routine check passed."});
      const afterSuccess=calls;await c.action("explain");assert.equal(calls,afterSuccess);assert.equal(c.status().live!.explanation.topic,"reported-outcome");
      await c.action("observation",{kind:"terminal",command:"new failing check",exitCode:1,text:"New failure: missing file."});
      assert.equal(c.status().live!.explanation.topic,"command-failure");assert.match(c.status().live!.explanation.whatItMeans,/new failing check/);
    }finally{p.store.close();}
  });

  it("recording a resolution fences a pending explanation from restoring the old suggestion",async()=>{
    const local=new LocalReasoner();let delayed=false,finish:((value:any)=>void)|undefined;
    const reasoner:Reasoner={id:"delayed",reason:input=>delayed?new Promise(resolve=>{finish=resolve;}):local.reason(input)};
    const {p,c}=make(Store.memory(),reasoner);try {
      const q=await imported(c);delayed=true;const pending=c.action("explain");
      await c.action("question-outcome",report(q));
      finish!({whatItMeans:"Stale explanation",whyItMattersHere:"Old context",nextCheck:q.text,usedObservationIds:q.observationIds,observed:[],inferred:[],unknown:[],confidence:.8,topic:"captured-intent",decisionNeeded:true,routineSuccess:false});
      await pending;assert.equal(c.status().live,null);assert.equal(c.status().questions.length,0);assert.equal(c.status().questionOutcomes.length,1);
    }finally{p.store.close();}
  });

  it("additive migration preserves legacy questions without assigning them current-goal authority",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"panther-legacy-q-")),path=join(dir,"state.sqlite");
    const db=new DatabaseSync(path);
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE questions(id TEXT PRIMARY KEY,text TEXT NOT NULL,observation_ids TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);");
    db.prepare("INSERT INTO questions VALUES (?,?,?,?,?,?)").run("legacy","Check from an earlier unscoped goal","[]","open",NOW,NOW);db.close();
    const store=Store.open(path);const {c}=make(store);
    try {
      const before=JSON.stringify(store.exportAll().questions);
      await c.action("goal",{hypothesis:"Current goal"});
      assert.equal(c.status().questions.length,0);assert.equal(c.status().legacyQuestionCount,1);assert.equal(JSON.stringify(store.exportAll().questions),before);
      await assert.rejects(c.action("question-outcome",{...report({id:"legacy",text:"",observationIds:[],status:"open",createdAt:NOW,updatedAt:NOW,revision:0,goalId:c.status().goal.id})}),/changed or is no longer open/);
      await c.action("prepare"); assert.match(c.status().live!.explanation.whatItMeans,/this goal/);
      assert.equal((store.exportAll().questionContext as unknown[]).length,0);
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });
});
