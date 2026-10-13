const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? `${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright` : 'playwright');
const thoughts = path.resolve(__dirname, '..');
const host = process.env.CT_ROLEPLAY_TOOLS_DIR || path.resolve(thoughts, '../sillytavern-roleplay-tools');
const newCss = fs.readFileSync(path.join(thoughts, 'style.css'), 'utf8');
const base = '/scripts/extensions/third-party/';
const stub = `export const eventSource={on(){}}; export const event_types={MESSAGE_RECEIVED:'message',CHAT_CHANGED:'chat'};
window.SillyTavern={getContext:()=>({characterId:0,characters:[{name:'Jungkook mafia boss',avatar:'card.png'}],chatId:'qa',chat:[]})};
localStorage.setItem('ct_cardmap_v2',JSON.stringify({'card:card.png':'qa'}));
localStorage.setItem('ct_profiles_v1',JSON.stringify({qa:{name:'College-au',folder:'',uploads:{},avatars:{},characters:Array.from({length:30},(_,i)=>'Character '+String(i+1).padStart(2,'0')),hiddenCharacters:['Hidden']}}));`;
function html(docked) {
 return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/st.css"><style>
 :root{--SmartThemeBlurTintColor:#201f1c;--SmartThemeBodyColor:#ece5d7;--SmartThemeQuoteColor:#e3b378;--mainFontFamily:Arial}
 body{margin:0;background:#131613;color:#ece5d7}*{box-sizing:border-box}button,select,input{font:inherit}
 </style>${docked?`<link rel="stylesheet" href="${base}host/style.css">`:''}<link rel="stylesheet" href="${base}thoughts/style.css"></head><body>
 <script type="module">await import('/script.js');${docked?`await import('${base}host/index.js');`:''}await import('${base}thoughts/index.js');</script></body></html>`;
}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CT_CHROMIUM_PATH ? {executablePath:process.env.CT_CHROMIUM_PATH} : {})});
 const summary=[];
 try {
  for(const scenario of [
   {name:'oversized saved block desktop',touch:false,docked:true,width:1100,height:850,panelHeight:600,blockHeight:1800,peer:true},
   {name:'oversized saved block tablet',touch:true,docked:true,width:820,height:1180,panelHeight:600,blockHeight:1800,peer:true},
   {name:'automatic blocks desktop',touch:false,docked:true,width:1100,height:850,panelHeight:600,peer:true},
   {name:'short saved block desktop',touch:false,docked:true,width:1100,height:850,panelHeight:600,blockHeight:310,peer:true},
   {name:'few characters saved block desktop',touch:false,docked:true,width:1100,height:850,panelHeight:600,blockHeight:800,peer:true,few:true},
  ]) {
   const context=await browser.newContext({viewport:{width:scenario.width,height:scenario.height},hasTouch:scenario.touch,isMobile:scenario.touch});
   const page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   let css=newCss;
   await page.route('http://qa.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:html(scenario.docked)});
    if(url.pathname==='/script.js') return route.fulfill({contentType:'text/javascript',body:(scenario.few?stub.replace('length:30','length:3'):stub)+`\nlocalStorage.setItem('wani_roleplay_tools_layout_v1',JSON.stringify({version:1,active:'live',pages:[{id:'live',name:'Live'}],geometry:{width:510,height:600,x:18,y:70},modules:{relations:{page:'live',order:0,height:220},thoughts:{page:'live',order:1,${scenario.blockHeight?'height:'+scenario.blockHeight:'weight:35'}}}}));`});
    if(url.pathname==='/st.css') return route.fulfill({contentType:'text/css',body:(process.env.CT_SILLYTAVERN_CSS ? fs.readFileSync(process.env.CT_SILLYTAVERN_CSS,'utf8') : '')});
    const match=url.pathname.match(/^\/scripts\/extensions\/third-party\/(host|thoughts)\/(index\.js|roleplay-tools-adapter\.js|style\.css)$/);
    if(!match) return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:match[2].endsWith('.css')?'text/css':'text/javascript',body:match[1]==='thoughts'&&match[2]==='style.css'?css:fs.readFileSync(path.join(match[1]==='host'?host:thoughts,match[2]),'utf8')});
   });
   await page.goto('http://qa.test/');
   await page.locator('#ct-panel').waitFor({state:'attached'});
   await page.evaluate(()=>{
    const peer=document.createElement('section');peer.id='peer';peer.innerHTML='<header>Relationship Memory Tracker</header><p>Love/Affection: 0% - Neutral</p><button>Parse Last</button>';
    peer.style.cssText='height:100%;padding:12px;';document.body.append(peer);
    WaniRoleplayTools.register({id:'relations',element:peer,minHeight:155});WaniRoleplayTools.open('thoughts');
   });
   await page.locator('#ct-gear').click();
   await page.locator('#ct-settings').waitFor({state:'visible'});
   await page.locator('#ct-settings').evaluate(el=>el.parentElement.scrollIntoView({block:'start'}));
   const info=()=>page.evaluate(()=>{
    const inner=document.querySelector('#ct-settings'),outer=document.querySelector('.rpt-page:not([hidden])'),panel=document.querySelector('#ct-panel');
    const r=inner.getBoundingClientRect(),o=outer.getBoundingClientRect();
    return {innerClient:inner.clientHeight,innerScroll:inner.scrollHeight,innerTop:inner.scrollTop,innerOverscroll:getComputedStyle(inner).overscrollBehaviorY,outerClient:outer.clientHeight,outerScroll:outer.scrollHeight,outerTop:outer.scrollTop,panelHeight:panel.getBoundingClientRect().height,x:r.x+r.width/2,y:Math.min(r.bottom,o.bottom)-40};
   });
   const before=await info();
   const cdp=await context.newCDPSession(page);
   if(scenario.touch){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:before.x,y:before.y}]});
    for(let n=1;n<=10;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:before.x,y:before.y-n*12}]});await new Promise(r=>setTimeout(r,16));}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   }else{await page.mouse.move(before.x,before.y);await page.mouse.wheel(0,220);}
   await new Promise(r=>setTimeout(r,300));
   const after=await info();
   const fixedBefore=before, fixedAfter=after;
   assert(fixedAfter.innerTop>fixedBefore.innerTop||fixedAfter.outerTop>fixedBefore.outerTop,scenario.name+': wheel/touch over content scrolls');
   assert.equal(fixedAfter.innerOverscroll,'auto');
   if(scenario.blockHeight>=800) assert(fixedAfter.outerTop>fixedBefore.outerTop,scenario.name+': host scrolls from settings content');
   else assert(fixedAfter.innerTop>fixedBefore.innerTop,scenario.name+': settings still scrolls');
   assert.equal(fixedAfter.panelHeight,fixedBefore.panelHeight,scenario.name+': geometry preserved');
   await page.locator('#ct-char-list .ct-char-row:last-child').scrollIntoViewIfNeeded();
   const lastReachable=await page.evaluate(()=>{
    const last=document.querySelector('#ct-char-list .ct-char-row:last-child').getBoundingClientRect();
    const inner=document.querySelector('#ct-settings').getBoundingClientRect();
    const outer=document.querySelector('.rpt-page:not([hidden])').getBoundingClientRect();
    return last.top>=Math.max(inner.top,outer.top)&&last.bottom<=Math.min(inner.bottom,outer.bottom);
   });
   assert(lastReachable,scenario.name+': last avatar row remains reachable');
   assert.deepEqual(errors,[]);
   console.log('PASS',scenario.name);
   summary.push({scenario:scenario.name,fixedBefore,fixedAfter});await context.close();
  }

 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
