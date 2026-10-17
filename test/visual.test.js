import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { electronEnv } from "../scripts/electron-env.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const goldenDir = join(root, "test/visual/golden");
const failureDir = join(root, "test/visual/_failures");
if (process.argv.includes("--visual-child")) {
  const { app, BrowserWindow, ipcMain, nativeImage } = electron;
  app.setPath("userData", process.env.WEFT_VISUAL_PROFILE);
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.commandLine.appendSwitch("disable-lcd-text");
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = {
    activeWorkspaceId: "fixture", workspaces: [{id:"fixture",name:"My workspace",icon:"W"}],
    materials: [], context: [], tasks: [], conversations: [], artifacts: [], activity: [], workflows: [], siteRules: [],
    settings: {theme:"light"}, storageWarnings: [],
  };
  let tabs = [{id:1,workspaceId:"fixture",title:"New tab",url:"about:blank",active:true,controller:"human",version:1}];
  const models = [{id:"local",name:"Local model",model:"fixture",endpoint:"http://localhost:11434/v1",locality:"on-device endpoint",capabilities:{tools:true}}];
  let window;
  let stopped = false, sent = null, exportArgs = null, clientArgs = null;
  const grants = [];
  const updateCalls = [];
  const updateStatus = {currentVersion:"1.0.0",channel:"stable",repository:"jxburros/Weft",install:{kind:"appimage",platform:"linux",arch:"x64",supported:true,method:"replace",reason:null},killSwitch:{active:false,variable:"WEFT_DISABLE_UPDATES"},automaticChecks:{enabled:false,intervalHours:24,stagesOnly:true,nextCheckAt:null},egress:{hosts:["github.com","objects.githubusercontent.com","release-assets.githubusercontent.com"],sends:"IP address, Weft version, platform and architecture (User-Agent). No workspace data, tokens or browsing data.",contactsNetwork:"only when you choose Check now"},lastCheck:null,staged:null,activation:{pending:null,health:null,history:[],failedVersions:[],rollback:{available:false,guidance:"Download the previous release from GitHub and verify it against SHA256SUMS.txt."}},warning:null};
  const run = async expression => {
    try { return await window.webContents.executeJavaScript(expression); }
    catch (error) { throw new Error(`${expression}: ${error.message}`); }
  };
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const until = async expression => { for(let i=0;i<100;i++) { if(await run(expression)) return; await pause(30); } throw Error(`Timed out: ${expression}`); };
  const compare = (reference, actual) => {
    assert.deepEqual(actual.getSize(), reference.getSize());
    const expected = reference.toBitmap(), pixels = actual.toBitmap(), diff = Buffer.alloc(pixels.length);
    let changed = 0;
    for(let i=0;i<pixels.length;i+=4) {
      const different = [0,1,2].some(c => Math.abs(expected[i+c]-pixels[i+c]) > 12);
      if(different) changed++;
      diff[i]=different?255:expected[i]; diff[i+1]=different?0:expected[i+1]; diff[i+2]=different?255:expected[i+2]; diff[i+3]=255;
    }
    return {ratio:changed/(pixels.length/4),diff:nativeImage.createFromBitmap(diff,actual.getSize())};
  };
  const capture = async name => {
    await until("innerWidth === 1200 && innerHeight === 800");
    await run('document.fonts.ready');
    await until(`document.getElementById("address").value === ${JSON.stringify(name.endsWith("-blocked") ? "https://restricted.example/" : "")}`);
    await run('document.activeElement?.blur(); document.getElementById("toast").hidden = true; document.getElementById("status").textContent = "Ready"');
    window.webContents.sendInputEvent({type:"mouseMove", x:1199, y:0});
    await pause(200);
    const path=join(goldenDir,`${name}.png`);
    let actual=await window.webContents.capturePage();
    if(process.env.WEFT_UPDATE_GOLDEN === "1") { mkdirSync(goldenDir,{recursive:true}); writeFileSync(path,actual.toPNG()); return; }
    assert.ok(existsSync(path),`Missing golden ${path}; review an intentional update with WEFT_UPDATE_GOLDEN=1`);
    const reference=nativeImage.createFromBuffer(readFileSync(path));
    let result=compare(reference,actual);
    if(result.ratio>.003) { await pause(200); actual=await window.webContents.capturePage(); result=compare(reference,actual); }
    if(result.ratio>.003) {
      mkdirSync(failureDir,{recursive:true});
      for(const [kind,img] of Object.entries({reference,actual,diff:result.diff})) writeFileSync(join(failureDir,`${name}-${kind}.png`),img.toPNG());
    }
    assert.ok(result.ratio<=.003,`${name}: ${(result.ratio*100).toFixed(3)}% pixels differ; see ${failureDir}`);
  };
  (async()=>{
    await app.whenReady();
    ipcMain.handle("weft:layout",()=>({}));
    ipcMain.handle("weft:commands",()=>({"settings.update":{description:"Update preferences",inputSchema:{type:"object",properties:{}}},"chat.preview":{description:"Preview request",inputSchema:{type:"object",properties:{}}}}));
    const fixtureExecute = (name,args)=>{
      if(name==="workspace.snapshot") return state;
      if(name==="tabs.list") return tabs;
      if(name==="models.list") return models;
      if(name==="browser.info") return {automation:{stopped}};
      if(name==="encryption.status") return {enabled:false,locked:false,lockReason:null,unlockMode:null,keyVersion:null,rotation:null,methods:{os:{configured:false,available:true,backend:"gnome_libsecret",protects:true,reason:null},recovery:{configured:false},passphrase:{configured:false}},coverage:{encrypted:[],notEncrypted:[],threatModel:""}};
      if(name==="browser.resumeAutomation") { stopped=false; return {}; }
      if(name==="conversations.create") { const c={id:"chat",workspaceId:"fixture",title:args.title,messages:[]};state.conversations.push(c);return c; }
      if(name==="chat.preview") return {disclosure:{endpoint:"https://model.example/v1",model:"fixture",locality:"remote",requiresAcknowledgement:true,items:[{kind:"message",title:"Your request",bytes:10}],tools:[],totalBytes:10}};
      if(name==="chat.send") { sent=args; return {}; }
      if(name==="workspaces.export") { exportArgs=args;return {format:"weft",residueScan:{status:"found",found:["sha256"],unverifiable:["image"],scope:"Text only"}}; }
      if(name==="settings.update") { Object.assign(state.settings,args); return state.settings; }
      if(name==="clients.list") return grants;
      if(name==="autonomy.get") return {bootstrapLevel:"autonomous",workspaceCeiling:null};
      if(name==="clients.create") { clientArgs=args; const grant={...args,clientId:"client-fixture",expiresAt:1893456000000,revoked:false};grants.push(grant);return {...grant,token:"weft1.fixture-secret-token"}; }
      if(name==="clients.revoke") { grants.find(g=>g.clientId===args.clientId).revoked=true;return {revoked:true}; }
      if(name==="tabs.activate") return tabs[0];
      if(name==="resume.get") return {workspaceId:"fixture",saved:false,view:{section:"overview",activeTabId:null,split:{tabId:null,focusedPane:"primary"},panels:{}},missing:{},pinned:[],pinnedMaterials:[],continue:{blockers:[],tasks:[],handoffs:[]},tabs:{count:0,suspended:0,groups:[]},notices:[]};
      if(name==="resume.save") return {};
      if(name==="search.status") return {lexical:{documents:1},vector:{enabled:false}};
      if(name==="display.status") return {mode:"headed",windowVisible:true,launchedHeadless:false,renderMode:"onscreen",tabs:{total:1,offscreen:0,onscreen:1,suspended:0},pendingApprovals:0,profile:{fingerprint:"0123456789abcdef"},transitions:[]};
      if(name==="resources.status") return {limits:{maxAgentCommands:8,maxPerClient:4,maxPerTask:2,captureConcurrency:1,captureQueueLimit:8,idleSuspendMinutes:30,memoryBudgetMb:null,maxCaptureEdge:4096},agentCommands:{running:0,byCommand:[]},captures:{running:0,queued:0,jobs:[]},memory:null,suspendedTabs:[],budgets:null};
      if(name.startsWith("update.")) updateCalls.push([name,args]);
      if(name==="update.status") return structuredClone(updateStatus);
      if(name==="update.configure") { updateStatus.automaticChecks.enabled=args.automaticChecks; return structuredClone(updateStatus); }
      if(name==="update.check") {
        updateStatus.lastCheck={at:"2026-10-17T12:00:00.000Z",status:"staged",message:"Weft 1.1.0 was downloaded and verified. It installs only when you choose Install.",latestVersion:"1.1.0",automatic:false};
        updateStatus.staged={version:"1.1.0",file:"Weft-1.1.0-x86_64.AppImage",size:128524649,sha512:"8rEgr2490uwZjPIerIGR3IcNvCzjsW+RyMS57E+nKZ+yQ3DbtMKQBshmzbRbP4q933KLSkUuTPykB1cgW4BN3w==",releaseTag:"v1.1.0",verifiedAt:"2026-10-17T12:00:00.000Z",verification:{sizeAndSha512:"verified_at_download",onDisk:"present",recheckedBeforeInstall:true},signature:{status:"platform_verified_on_open",subject:null,reason:"Linux packages are verified by release manifest size and SHA-512 only."},releaseUrl:"https://github.com/jxburros/Weft/releases/tag/v1.1.0"};
        return {status:"staged",message:updateStatus.lastCheck.message};
      }
      if(name==="update.install") return {status:"restarting",message:"Weft 1.1.0 is installed and will restart now."};
      throw Error(`Unexpected fixture command ${name}`);
    };
    ipcMain.handle("weft:execute", (_event, name, args) => ({ result: fixtureExecute(name, args) }));
    window=new BrowserWindow({width:1200,height:800,useContentSize:true,show:true,webPreferences:{preload:join(root,"src/preload.cjs"),contextIsolation:true,sandbox:true}});
    // Remove platform menu geometry before fixing the renderer viewport.
    window.removeMenu();
    window.setContentSize(1200,800);
    await window.loadFile(join(root,"src/gui.html"));
    await until("innerWidth === 1200 && innerHeight === 800");
    await until('document.getElementById("content").textContent.includes("Make room")');
    // Native modal focus, accessible name, Escape, and restoration are exercised in Chromium.
    await run('document.getElementById("search-button").focus()');
    await click('#search-button');
    await until('document.activeElement?.id === "palette-query"');
    assert.equal(await run('document.getElementById("dialog").getAttribute("aria-labelledby")'),"dialog-title");
    for(let i=0;i<8;i++) {
      window.webContents.sendInputEvent({type:"keyDown",keyCode:"Tab"});
      window.webContents.sendInputEvent({type:"keyUp",keyCode:"Tab"});
      await pause(10);
      assert.equal(await run('document.getElementById("dialog").contains(document.activeElement)'),true,"native modal traps keyboard focus");
    }
    window.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});
    window.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});
    await until('!document.getElementById("dialog").open');
    // Chromium can finish its own modal-close steps a tick after the dialog reports closed; focus must still return.
    await until('document.activeElement?.id === "search-button"');
    // Safety decisions stay in trusted chrome, and cancellation never sends a request.
    await click('#agent-toggle');
    await run('document.getElementById("chat-input").value="Private draft";document.getElementById("chat-form").requestSubmit()');
    await until('document.getElementById("acknowledge-disclosure") !== null');
    await click('[data-action="close-dialog"]');
    await until('!document.getElementById("chat-send").disabled');
    assert.equal(sent,null);
    assert.equal(await run('document.getElementById("chat-input").value'),"Private draft");
    await run('document.getElementById("chat-form").requestSubmit()');
    await until('document.getElementById("dialog").open && document.getElementById("acknowledge-disclosure") !== null');
    await click('#acknowledge-disclosure');
    await until('!document.getElementById("chat-send").disabled');
    assert.equal(sent.disclosureAck,true);
    await click('[data-action="close-agent"]');
    state.conversations=[];
    stopped=true;
    state.storageWarnings=[{code:"SYNC_CONFLICT_COPY",message:"A conflicted copy requires review."}];
    await until('document.getElementById("safety-notices").textContent.includes("conflicted copy")');
    assert.match(await run('document.getElementById("safety-notices").textContent'),/Agent activity is stopped/);
    await click('[data-action="resume-automation"]');
    await until('!document.getElementById("safety-notices").textContent.includes("Agent activity is stopped")');
    assert.equal(stopped,false);
    state.storageWarnings=[];
    await click('#settings-button');
    await click('[data-action="export-workspace"]');
    await run('document.querySelector("[name=sensitiveTerms]").value="secret\\nprivate";document.getElementById("export-form").requestSubmit()');
    await until('document.getElementById("save-export") !== null');
    assert.deepEqual(exportArgs.sensitiveTerms,["secret","private"]);
    assert.match(await run('document.getElementById("export-review").textContent'),/found/);
    assert.match(await run('document.getElementById("export-review").textContent'),/1 items could not be verified/);
    await click('[data-action="close-dialog"]');
    await click('[data-action="manage-clients"]');
    await until('document.getElementById("dialog-title").textContent === "Agent connections"');
    await click('[data-action="new-client"]');
    await run('document.querySelector("#client-form [name=name]").value="Research assistant";document.querySelectorAll("#client-form [name=scope]")[1].checked=true;document.getElementById("client-form").requestSubmit()');
    await until('document.getElementById("new-client-token") !== null');
    assert.equal(await run('document.getElementById("new-client-token").value'),"weft1.fixture-secret-token");
    assert.deepEqual(clientArgs,{name:"Research assistant",purpose:"",scopes:["read","records.write"],actionClasses:[],autonomy:"scoped",dataAccess:["workspace_records","conversations","page_content","page_capture","browsing_history","activity"],destinations:["*"],maxCommands:null,workspaceIds:["fixture"],crossWorkspace:false,ttlSeconds:3600});
    assert.doesNotMatch(await run('document.getElementById("result").textContent'),/fixture-secret-token/);
    await click('[data-action="close-dialog"]');
    await until('document.getElementById("new-client-token") === null');
    await click('[data-action="manage-clients"]');
    await until('document.querySelector("[data-action=revoke-client]") !== null');
    await click('[data-action="revoke-client"]');
    await until('document.getElementById("dialog-content").textContent.includes("Revoked")');
    assert.equal(grants[0].revoked,true);
    await click('[data-action="close-dialog"]');
    await until('document.getElementById("safety-notices").hidden');
    // Update Center: disclosed, human-triggered checks; installs only the staged version shown.
    await click('[data-section="updates"]');
    await until('document.getElementById("update-center")?.textContent.includes("Weft 1.0.0")');
    assert.match(await run('document.getElementById("update-center").textContent'),/github\.com.*No workspace data/s);
    assert.equal(await run('document.querySelector("[data-action=install-update]")'),null);
    assert.deepEqual(updateCalls.map(([name])=>name),["update.status"],"opening the Update Center performs no check");
    await click('[data-action="check-updates"]');
    await until('document.querySelector("[data-action=install-update]") !== null');
    assert.match(await run('document.getElementById("update-center").textContent'),/Size and SHA-512 match the release manifest/);
    await run('document.getElementById("auto-updates").click()');
    await until('document.getElementById("auto-updates").checked');
    assert.equal(updateStatus.automaticChecks.enabled,true);
    await click('[data-action="install-update"]');
    await until('document.getElementById("toast").textContent.includes("restart")');
    assert.deepEqual(updateCalls.filter(([name])=>name!=="update.status"),[["update.check",{}],["update.configure",{automaticChecks:true}],["update.install",{version:"1.1.0"}]]);
    updateStatus.killSwitch.active=true;
    await click('#settings-button');
    await click('[data-section="updates"]');
    await until('document.getElementById("update-center")?.textContent.includes("turned off by WEFT_DISABLE_UPDATES")');
    assert.equal(await run('document.querySelector("[data-action=check-updates]").disabled'),true);
    assert.equal(await run('document.querySelector("[data-action=install-update]").disabled'),true);
    updateStatus.killSwitch.active=false;
    for(const theme of ["light","dark"]) {
      state.settings.theme=theme;
      state.materials=[];
      await click('#home');
      if(await run('document.documentElement.dataset.theme')!==theme) await click('#theme-toggle');
      await until(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
      await capture(`${theme}-empty`);
      state.materials=[{id:"note",workspaceId:"fixture",kind:"note",title:"A useful reference",content:"Keep exact sources and record open questions.",updatedAt:"2026-01-01T12:00:00.000Z"}];
      await pause(1600);
      await click('[data-section="materials"]');
      await capture(`${theme}-materials`);
      await click('#agent-toggle');
      await capture(`${theme}-ask`);
      await click('[data-action="close-agent"]');
      await click('#settings-button');
      await capture(`${theme}-settings`);
      await click('[data-action="manage-clients"]');
      await until('document.getElementById("dialog").open');
      await capture(`${theme}-connections`);
      await click('[data-action="close-dialog"]');
      tabs=[{...tabs[0],url:"https://restricted.example/",title:"Restricted destination",blocked:{reason:"Your workspace rule blocks this destination.",provenance:{sourceRepo:"community/site-rules",commit:"1234567890abcdef"}}}];
      await pause(1600);
      await click('[data-action="activate-tab"]');
      await capture(`${theme}-blocked`);
      assert.match(await run('document.getElementById("content").textContent'),/Community list provenance \(untrusted\): community\/site-rules @ 1234567890abcdef/);
      tabs=[{...tabs[0],url:"about:blank",title:"New tab",blocked:null}];
      await pause(1600);
    }
    await window.webContents.executeJavaScript('document.documentElement.style.fontSize="32px"');
    window.setContentSize(1000,700);
    await click('#home');
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'),true,"200% text scale does not overflow app");
    await window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    assert.equal(await run('getComputedStyle(document.querySelector("button")).transitionDuration'),"0s");
    console.log("WEFT_VISUAL_OK"); app.quit();
  })().catch(error=>{console.error(error);app.exit(1);});
} else {
  test("Linux GUI goldens and keyboard accessibility",{timeout:90000,skip:process.env.WEFT_VISUAL!=="1"?"Set WEFT_VISUAL=1 under xvfb-run":process.platform!=="linux"?"Goldens target Linux":false},async()=>{
    const profile=mkdtempSync(join(tmpdir(),"weft-visual-"));
    // Glyph rasterisation follows fontconfig even for the bundled web fonts. Pin the stock Ubuntu
    // rendering (slight hinting, greyscale antialiasing, DejaVu Sans as the sans-serif fallback) so a
    // machine-local override such as forced unhinted text or a preferred UI font cannot shift goldens.
    const fontconfig=join(profile,"fonts.conf");
    writeFileSync(fontconfig,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><match target="pattern"><test name="family"><string>sans-serif</string></test><edit name="family" mode="prepend_first" binding="strong"><string>DejaVu Sans</string></edit></match><match target="font"><edit name="antialias" mode="assign"><bool>true</bool></edit><edit name="hinting" mode="assign"><bool>true</bool></edit><edit name="hintstyle" mode="assign"><const>hintslight</const></edit><edit name="autohint" mode="assign"><bool>false</bool></edit><edit name="rgba" mode="assign"><const>none</const></edit><edit name="lcdfilter" mode="assign"><const>lcddefault</const></edit></match></fontconfig>`);
    const child=spawn(electron,["--no-sandbox","--disable-gpu",fileURLToPath(import.meta.url),"--visual-child"],{env:electronEnv({ WEFT_VISUAL_PROFILE:profile,FONTCONFIG_FILE:fontconfig,TZ:"UTC",LANG:"en_US.UTF-8" }),stdio:["ignore","pipe","pipe"]});
    let output=""; child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);
    const timer=setTimeout(()=>child.kill("SIGKILL"),80000);
    try { const code=await new Promise((resolve,reject)=>{child.on("exit",resolve);child.on("error",reject);}); assert.equal(code,0,output); assert.match(output,/WEFT_VISUAL_OK/); }
    finally {clearTimeout(timer);rmSync(profile,{recursive:true,force:true});}
  });
}
