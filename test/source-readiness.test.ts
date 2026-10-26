import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlCursor } from "../src/adapters/jsonl.js";
import { TerminalAdapter } from "../src/adapters/terminal.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { AgentEventAdapter } from "../src/adapters/agent.js";
import { Store } from "../src/state/store.js";
import { Panther } from "../src/ingest.js";
import { LocalReasoner } from "../src/core/reasoner.js";
import { CompanionController } from "../src/controller.js";

const T1 = "2026-10-26T03:00:00.000Z", T2 = "2026-10-26T03:01:00.000Z", T3 = "2026-10-26T03:02:00.000Z";
function fixture() { const dir=mkdtempSync(join(tmpdir(),"panther-readiness-")); return {dir,path:join(dir,"private-source.jsonl"),close:()=>rmSync(dir,{recursive:true,force:true})}; }

describe("source read readiness",()=>{
  it("distinguishes not checked, missing, readable empty, partial, received and waiting without probing on status",()=>{
    const f=fixture(), cursor=new JsonlCursor(); try {
      assert.equal(cursor.status().state,"not-checked");
      assert.deepEqual(cursor.read(f.path,T1),[]);
      assert.equal(cursor.status().state,"unavailable"); assert.equal(cursor.status().error,"missing");
      assert.equal(cursor.status().lastAttemptAt,T1); assert.equal(cursor.status().lastSuccessAt,null);
      assert.ok(!JSON.stringify(cursor.status()).includes(f.path));
      writeFileSync(f.path,""); assert.equal(cursor.status().state,"unavailable");
      assert.deepEqual(cursor.read(f.path,T2),[]); assert.equal(cursor.status().state,"waiting");
      assert.equal(cursor.status().lastSuccessAt,T2); assert.equal(cursor.status().lastEvidenceAt,null);
      appendFileSync(f.path,'{"message":"still being written');
      assert.deepEqual(cursor.read(f.path,T3),[]); assert.equal(cursor.status().state,"partial");
      appendFileSync(f.path,'"}\n'); assert.equal(cursor.read(f.path,T3)[0].message,"still being written");
      assert.equal(cursor.status().state,"ready"); assert.equal(cursor.status().lastEvidenceAt,T3);
      assert.deepEqual(cursor.read(f.path,T3),[]); assert.equal(cursor.status().state,"waiting"); assert.equal(cursor.status().recordsRead,0);
      const snapshot=cursor.status(); snapshot.state="invalid"; assert.equal(cursor.status().state,"waiting");
    } finally {f.close();}
  });
  it("keeps invalid input visible through empty polls and recovers on a clean valid record",()=>{
    const f=fixture(), cursor=new JsonlCursor(); try {
      writeFileSync(f.path,'broken\nnull\n[]\n{"message":"valid among invalid"}\n');
      assert.equal(cursor.read(f.path,T1).length,1); assert.equal(cursor.status().state,"invalid");
      assert.equal(cursor.status().recordsSkipped,3); assert.equal(cursor.status().lastEvidenceAt,T1);
      assert.deepEqual(cursor.read(f.path,T2),[]); assert.equal(cursor.status().state,"invalid");
      assert.equal(cursor.status().recordsSkipped,3); assert.equal(cursor.status().lastSuccessAt,T2); assert.equal(cursor.status().lastEvidenceAt,T1);
      renameSync(f.path,f.path+".away"); cursor.read(f.path,T2); assert.equal(cursor.status().error,"missing");
      renameSync(f.path+".away",f.path); cursor.read(f.path,T2); assert.equal(cursor.status().state,"invalid");
      appendFileSync(f.path,'{"message":"recovered"}\n'); assert.equal(cursor.read(f.path,T3)[0].message,"recovered");
      assert.equal(cursor.status().state,"ready"); assert.equal(cursor.status().recordsSkipped,0); assert.equal(cursor.status().error,null);
    } finally {f.close();}
  });
  it("reports non-files and unreadable sources using safe codes without disclosing paths",()=>{
    const f=fixture(), cursor=new JsonlCursor(); try {
      assert.deepEqual(cursor.read(f.dir,T1),[]); assert.equal(cursor.status().error,"not-file");
      symlinkSync(f.path,f.path); assert.deepEqual(cursor.read(f.path,T2),[]);
      assert.equal(cursor.status().state,"unavailable"); assert.equal(cursor.status().error,"unreadable");
      assert.ok(!JSON.stringify(cursor.status()).includes(f.dir));
      assert.equal(cursor.status().lastSuccessAt,null);
    } finally {f.close();}
  });
  it("preserves UTF-8 across the 1 MiB boundary and reads the remaining record only once",()=>{
    const f=fixture(), cursor=new JsonlCursor(); try {
      const line=Buffer.from('{"message":"A 😊 result"}\n');
      const prefixLength=1024*1024-line.indexOf(Buffer.from("😊"))-2;
      const prefix=(" ".repeat(63)+"\n").repeat(Math.floor(prefixLength/64))+"\n".repeat(prefixLength%64);
      writeFileSync(f.path,Buffer.concat([Buffer.from(prefix),line]));
      assert.deepEqual(cursor.read(f.path,T1),[]); assert.equal(cursor.status().state,"partial"); assert.equal(cursor.status().hasMore,true);
      assert.equal(cursor.read(f.path,T2)[0].message,"A 😊 result"); assert.equal(cursor.status().hasMore,false);
      assert.deepEqual(cursor.read(f.path,T3),[]); assert.equal(cursor.status().lastEvidenceAt,T2);
    } finally {f.close();}
  });
  it("discards the full oversized line instead of interpreting its later tail as a new record",()=>{
    const f=fixture(), cursor=new JsonlCursor(); try {
      writeFileSync(f.path,"x".repeat(1024*1024+100)+'{"message":"not a separate event"}\n{"message":"real next event"}\n');
      assert.deepEqual(cursor.read(f.path,T1),[]); assert.equal(cursor.status().state,"invalid"); assert.equal(cursor.status().hasMore,true);
      assert.deepEqual(cursor.read(f.path,T2),[{message:"real next event"}]); assert.equal(cursor.status().state,"ready");
      assert.deepEqual(cursor.read(f.path,T3),[]);
    } finally {f.close();}
  });
  it("resets partial and malformed state on truncation or file replacement",()=>{
    const f=fixture(), cursor=new JsonlCursor(); try {
      writeFileSync(f.path,"broken data without a newline"); cursor.read(f.path,T1); assert.equal(cursor.status().state,"partial");
      writeFileSync(f.path,"bad\n"); cursor.read(f.path,T2); assert.equal(cursor.status().state,"invalid");
      writeFileSync(f.path,""); cursor.read(f.path,T3); assert.equal(cursor.status().state,"waiting");
      renameSync(f.path,f.path+".old"); writeFileSync(f.path,'{"message":"replacement"}\n');
      assert.equal(cursor.read(f.path,T3)[0].message,"replacement"); assert.equal(cursor.status().state,"ready");
    } finally {f.close();}
  });
  it("all three JSONL adapters expose cached readiness without changing their legacy source strings",async()=>{
    const f=fixture(); try {
      for(const Adapter of [TerminalAdapter,BrowserAdapter,AgentEventAdapter]) {
        const adapter=new Adapter(f.path);
        assert.equal(adapter.readiness().state,"not-checked"); assert.match(adapter.status(),/: configured$/);
        await adapter.capture({now:T1}); assert.equal(adapter.readiness().error,"missing"); assert.equal(adapter.readiness().lastAttemptAt,T1);
      }
    } finally {f.close();}
  });
  it("status, Pause, Resume and an expired Follow session never read; explicit reads recover independently of manual evidence",async()=>{
    const f=fixture(); let time=T1;
    const adapter=new TerminalAdapter(f.path);
    const p=new Panther({store:Store.memory(),adapters:[adapter],reasoner:new LocalReasoner(),threshold:.25,followMinutes:25,insightTtlMinutes:45});
    const c=new CompanionController(p,()=>time);
    try {
      await c.action("goal",{hypothesis:"Check the current terminal result"});
      assert.deepEqual(c.status().sources,["terminal: configured"]);
      assert.equal(c.status().sourceReadiness[0].lastAttemptAt,null);
      await c.action("follow"); assert.equal(c.status().sourceReadiness[0].state,"unavailable");
      await c.action("observation",{kind:"note",text:"Manual context remains available."}); assert.equal(c.status().observations.length,1);
      assert.equal(c.status().sourceReadiness[0].lastAttemptAt,T1);
      await c.action("pause",{paused:true}); time=T2;
      writeFileSync(f.path,'{"command":"npm test","exitCode":1,"stderr":"A synthetic failure"}\n');
      c.status(); await c.tick(); await c.action("explain");
      assert.equal(c.status().sourceReadiness[0].lastAttemptAt,T1); assert.equal(c.status().observations.length,1);
      await c.action("pause",{paused:false}); await c.tick(); assert.equal(c.status().sourceReadiness[0].lastAttemptAt,T1);
      await c.action("follow"); assert.equal(c.status().sourceReadiness[0].state,"ready"); assert.equal(c.status().sourceReadiness[0].lastEvidenceAt,T2);
      time="2026-10-26T04:00:00.000Z";
      appendFileSync(f.path,'{"command":"npm run build","exitCode":1,"stderr":"Later"}\n');
      await c.tick(); assert.equal(c.status().session?.status,"ended"); assert.equal(c.status().sourceReadiness[0].lastAttemptAt,T2);
      time="2026-10-26T04:01:00.000Z"; await c.action("explain"); assert.equal(c.status().sourceReadiness[0].lastAttemptAt,time);
      time="2026-10-26T04:02:00.000Z"; await c.action("prepare"); assert.equal(c.status().sourceReadiness[0].lastAttemptAt,time);
    } finally {c.stop();p.store.close();f.close();}
  });
});
