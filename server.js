// Pet Memory Hologram backend — order-verified Kling generation + persistent Memorial Wall.
// Dependency-free Node (>=18). Run:  node server.js
//
// Env vars:
//   SHOPLAZZA_HOST   e.g. https://petmenory.com
//   SHOPLAZZA_TOKEN  Shoplazza private-app access token
//   KLING_AK / KLING_SK   Kling Open Platform keys
//   PUBLIC_URL       public base URL of this server, e.g. https://pawmemory-hologram.onrender.com
//   PORT             optional, default 3000
//
// Endpoints:
//   GET  /api/health
//   POST /api/generate   {orderNumber, photo(dataURL), name, type, actions[]}
//                        -> verify paid order -> Kling film -> download & store -> save pet
//                        -> { ok, petId, videoUrl, wallUrl }
//   GET  /api/pets       -> JSON list of saved pets (for the studio / apps)
//   GET  /wall           -> Memorial Wall page (avatar + name grid)
//   GET  /pet/:id        -> fullscreen projection player for one pet
//   GET  /data/...       -> stored photos & videos

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SHOP = process.env.SHOPLAZZA_HOST || "https://petmenory.com";
const SHOP_TOKEN = process.env.SHOPLAZZA_TOKEN || "";
const KLING_API_KEY = process.env.KLING_API_KEY || "";   // new-style single API key (preferred)
const KLING_AK = process.env.KLING_AK || "";             // legacy Access Key (JWT mode)
const KLING_SK = process.env.KLING_SK || "";             // legacy Secret Key (JWT mode)
const KLING_HOST = process.env.KLING_HOST || "https://api-beijing.klingai.com";
const REMOVEBG_API_KEY = process.env.REMOVEBG_API_KEY || "";  // remove.bg key — projection-mode cutout
const ADMIN_KEY = process.env.ADMIN_KEY || "";                // merchant console key (manual fulfilment)
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

const DATA = path.join(__dirname, "data");
const PHOTOS = path.join(DATA, "photos");
const VIDEOS = path.join(DATA, "videos");
const DB = path.join(DATA, "pets.json");
[DATA, PHOTOS, VIDEOS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, "[]");

const MOTION_VARIANTS = new Set([
  "32702b58-5d3c-4345-8631-6a8ac1777620","45174fd4-c66c-4b72-8991-bbbbc0d32769",
  "54d54156-cf08-4797-a4ad-1d47b1c4827a","850c088e-5560-4efe-b49e-a822835b1902",
  "c7e0e013-b1c6-4ac9-9d09-11e2cbe8ac6b","41d8e897-ec94-47af-a4df-eb4af7313412",
  "7b119891-afd1-4071-92b0-853a286afe10","eb69e6ec-3a82-459c-b555-901dfe004bda",
]);
const VERB = { wag:"wags its tail gently",blink:"blinks its eyes softly",run:"runs and plays happily",
  nuzzle:"nuzzles toward you affectionately",tilt:"tilts its head curiously",look:"looks around slowly",
  sit:"sits calmly and breathes",stretch:"stretches its body in the warm light" };

const readPets = () => { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return []; } };
const writePets = p => fs.writeFileSync(DB, JSON.stringify(p, null, 2));

// daily cap on free submissions (SoulBridge-style scarcity)
const LIMITS = path.join(DATA, "limits.json");
function checkDailyLimit(){
  const today = new Date().toISOString().slice(0,10);
  let d = {date:today, count:0};
  try { d = JSON.parse(fs.readFileSync(LIMITS, "utf8")); } catch {}
  if(d.date !== today) d = {date:today, count:0};
  const MAX = parseInt(process.env.FREE_DAILY_LIMIT || "50", 10);
  if(d.count >= MAX) return false;
  d.count++;
  fs.writeFileSync(LIMITS, JSON.stringify(d));
  return true;
}

const SCENE_PROMPT={
  warm:"warm candle-lit glow, cozy golden ambience",
  starry:"starry night sky, gentle starlight, deep blue night ambience",
  sunset:"golden sunset light, warm orange dusk ambience"};
function buildPrompt(name, type, actions, scene, projection) {
  const noun = type === "cat" ? "cat" : "dog";
  const who = name || "your friend";
  const moves = (actions || []).map(a => VERB[a]).filter(Boolean);
  const motion = moves.length ? moves.join(", and ") : "moves gently";
  // tuned against competitor samples: vivid motion + happy expression + bright warm light read best on black
  const lively="happy tongue-out smile the whole time, visible tail wag, playful head tilts, ears wiggling, bright warm studio lighting, vivid fur colors, clear noticeable gentle motion — not static";
  if (projection) {
    return `A photorealistic ${noun} named ${who} ${motion}, ${lively}. Pure solid black background, subject fully visible and centered, hologram-projection ready, smooth lifelike animation, loopable clip.`;
  }
  const mood = SCENE_PROMPT[scene] || SCENE_PROMPT.warm;
  return `A photorealistic ${noun} named ${who} ${motion}. Cinematic, ${mood}, shallow depth of field, gentle and lifelike motion, loopable clip.`;
}

async function verifyOrder(orderNumber) {
  if (!SHOP_TOKEN) throw new Error("SHOPLAZZA_TOKEN not configured");
  const r = await fetch(`${SHOP}/openapi/2026-07/orders?limit=250`, { headers: { "access-token": SHOP_TOKEN } });
  const j = await r.json();
  const o = ((j.data && j.data.orders) || []).find(x => String(x.number).trim().toUpperCase() === String(orderNumber).trim().toUpperCase());
  if (!o) return { ok: false, reason: "Order number not found." };
  const paid = ["paid","partially_paid","settled"].includes(String(o.financial_status).toLowerCase());
  if (!paid) return { ok: false, reason: `Order ${o.number} is not paid yet (${o.financial_status}).` };
  const bought = (o.line_items || []).filter(li => MOTION_VARIANTS.has(li.variant_id));
  if (!bought.length) return { ok: false, reason: "This order doesn't include a hologram motion." };
  return { ok: true, motions: bought.length };
}

function b64url(b){ return Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function mintJWT(ak,sk){
  const h=b64url(JSON.stringify({alg:"HS256",typ:"JWT"}));
  const p=b64url(JSON.stringify({iss:ak,exp:Math.floor(Date.now()/1000)+1800}));
  const s=crypto.createHmac("sha256",sk).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(s)}`;
}
// new single API key takes priority; fall back to legacy AK/SK JWT
function klingAuth(){
  if(KLING_API_KEY) return "Bearer "+KLING_API_KEY;
  if(KLING_AK&&KLING_SK) return "Bearer "+mintJWT(KLING_AK,KLING_SK);
  return null;
}
async function klingVideoUrl(photoDataUrl,prompt){
  const auth=klingAuth();
  if(!auth) throw new Error("Kling keys not configured");
  const c=await fetch(`${KLING_HOST}/v1/videos/image2video`,{method:"POST",
    headers:{Authorization:auth,"Content-Type":"application/json"},
    body:JSON.stringify({model_name:"kling-v2-6",image:photoDataUrl,prompt,duration:"5",mode:"pro",sound:"off"})});
  const cj=await c.json();
  if(!cj.data||!cj.data.task_id) throw new Error("Kling create failed: "+(cj.message||c.status));
  const id=cj.data.task_id;
  for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,5000));
    const q=await fetch(`${KLING_HOST}/v1/videos/image2video/${id}`,{headers:{Authorization:auth}});
    const qj=await q.json(); const st=qj.data&&qj.data.task_status;
    if(st==="succeed"){
      const tr=qj.data.task_result||{};
      const u=(tr.works&&tr.works[0]&&tr.works[0].resource_url)||(tr.videos&&tr.videos[0]&&tr.videos[0].url);
      if(u) return u;
      throw new Error("Kling succeeded but no video URL");
    }
    if(st==="failed") throw new Error("Kling generation failed: "+(qj.data.task_status_msg||""));
  }
  throw new Error("Kling timed out");
}

// Projection mode: cut the pet out and place it on a true-black background
// (Kling image2video keeps the source background, so the black must exist in the input image).
// Uses remove.bg (bg_color=000000 returns the cutout composited on black directly).
async function prepareImage(photoDataUrl, projection){
  if(!projection) return photoDataUrl;
  if(!REMOVEBG_API_KEY) return photoDataUrl;   // no cutout key → send raw photo
  const base64=String(photoDataUrl).replace(/^data:image\/\w+;base64,/,"");
  const form=new URLSearchParams();
  form.append("image_file_b64",base64);
  form.append("size","auto");
  form.append("bg_color","000000");
  form.append("format","jpg");
  const r=await fetch("https://api.remove.bg/v1.0/removebg",{method:"POST",
    headers:{"X-Api-Key":REMOVEBG_API_KEY,"Content-Type":"application/x-www-form-urlencoded"},
    body:form.toString()});
  if(!r.ok) throw new Error("background removal failed: "+r.status);
  const buf=Buffer.from(await r.arrayBuffer());
  return "data:image/jpeg;base64,"+buf.toString("base64");
}

function saveDataUrl(dataUrl,dest){
  const m=/^data:image\/(\w+);base64,(.+)$/.exec(dataUrl||"");
  if(!m) return null;
  fs.writeFileSync(dest,Buffer.from(m[2],"base64"));
  return true;
}
function saveVideoDataUrl(dataUrl,dest){
  const m=/^data:video\/(\w+);base64,(.+)$/.exec(dataUrl||"");
  const b64=m?m[2]:String(dataUrl||"");
  if(!b64||b64.length<100) return null;
  fs.writeFileSync(dest,Buffer.from(b64,"base64"));
  return true;
}
// detect mp4 codec by sniffing the ftyp brand (HEVC vs H.264)
function detectCodec(filePath){
  try{
    const fd=fs.openSync(filePath,"r");
    const buf=Buffer.alloc(64);
    fs.readSync(fd,buf,0,64,0); fs.closeSync(fd);
    if(buf.toString("ascii",4,8)!=="ftyp") return "unknown";
    const brands=new Set();
    const major=buf.toString("ascii",8,12).toLowerCase(); if(major) brands.add(major);
    let off=16;
    while(off+4<=64){
      const b=buf.toString("ascii",off,off+4).toLowerCase();
      if(!b || b==="\0\0\0\0") break;
      brands.add(b); off+=4;
    }
    if(brands.has("hevc")||brands.has("hevx")||brands.has("hvc1")||brands.has("hev1")) return "hevc";
    if(brands.has("mp42")||brands.has("mp41")||brands.has("isom")) return "h264-or-other";
    return "other";
  }catch(e){ return "unknown"; }
}
let _ffmpegPath=null;
function getFfmpegPath(){
  if(_ffmpegPath!==null) return _ffmpegPath || null;
  try{ _ffmpegPath=require("@ffmpeg-installer/ffmpeg").path; }catch(e){ _ffmpegPath=false; }
  return _ffmpegPath || null;
}
async function transcodeToH264(filePath){
  const fp=getFfmpegPath(); if(!fp) return false;
  const tmp=filePath+".tmp.mp4";
  return new Promise((resolve)=>{
    const{spawnSync}=require("child_process");
    const r=spawnSync(fp,["-y","-i",filePath,"-c:v","libx264","-pix_fmt","yuv420p","-preset","fast","-crf","22","-c:a","aac","-b:a","128k","-movflags","+faststart","-loglevel","error",tmp],{timeout:180000});
    if(r.status===0 && fs.existsSync(tmp) && fs.statSync(tmp).size>1000){
      try{fs.unlinkSync(filePath);}catch(e){}
      fs.renameSync(tmp,filePath);
      resolve(true);
    } else { try{fs.unlinkSync(tmp);}catch(e){} resolve(false); }
  });
}
async function downloadTo(url,dest){
  const r=await fetch(url); if(!r.ok) throw new Error("download failed "+r.status);
  fs.writeFileSync(dest,Buffer.from(await r.arrayBuffer()));
}

const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function wallHTML(allPets){
  const pets=allPets.filter(p=>p.status==="ready");   // wall shows finished films only
  const cards=pets.map(p=>`
    <a class="card" href="/pet/${p.id}">
      <div class="avatar"><img src="/data/photos/${p.id}.jpg" alt="${esc(p.name)}"></div>
      <div class="nm">${esc(p.name)}</div>
      ${p.dates?`<div class="dt">${esc(p.dates)}</div>`:""}
      <div class="tp">${p.type==="cat"?"🐱":"🐶"}</div>
    </a>`).join("");
  const empty=`<div class="empty">No little souls here yet.<br>Generate your first film and they'll appear on this wall, forever.</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memorial Wall — Pet Memory</title><style>
body{margin:0;background:#14100d;color:#F4EBDD;font-family:Georgia,serif;min-height:100vh}
.wrap{max-width:900px;margin:0 auto;padding:48px 22px}
h1{font-weight:600;text-align:center;font-size:34px;margin:0 0 8px}
.sub{text-align:center;color:#C9A86A;margin:0 0 40px;font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:20px}
.card{text-decoration:none;color:inherit;text-align:center;display:block}
.avatar{width:100%;aspect-ratio:1/1;border-radius:50%;overflow:hidden;margin:0 auto 10px;
  border:2px solid #B0894F;box-shadow:0 0 24px rgba(201,168,106,.35);background:#241d18}
.avatar img{width:100%;height:100%;object-fit:cover}
.nm{font-size:18px}.tp{font-size:14px;color:#C9A86A;margin-top:2px}
.dt{font-size:12px;color:#8a7d6f;letter-spacing:1px;margin-top:2px}
.card:hover .avatar{box-shadow:0 0 34px rgba(201,168,106,.6)}
.empty{text-align:center;color:#8a7d6f;padding:60px 20px;line-height:1.7;font-size:16px}
footer{text-align:center;color:#8a7d6f;font-size:13px;margin-top:50px}
</style></head><body><div class="wrap">
<h1>The Memorial Wall</h1>
<p class="sub">Every little soul, kept in light. Tap one to bring them close.</p>
<div class="grid">${cards||empty}</div>
<footer>Pet Memory · forever in our hearts</footer>
</div></body></html>`;
}

function petHTML(p){
  const oneLine=p.oneLine||p.letter||"";
  const shareUrl=encodeURIComponent(`${PUBLIC_URL}/pet/${p.id}`);
  const shareText=encodeURIComponent(`${esc(p.name)} — forever in light. 🕯️`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} — Pet Memory</title><style>
*{box-sizing:border-box}
body{margin:0;background:#0f0c09;color:#F4EBDD;font-family:Georgia,serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:0 0 60px}
.top{padding:20px 16px 4px;text-align:center;font-size:12px;letter-spacing:3px;color:#6f6455;text-transform:uppercase}
.top b{color:#C9A86A}
.vid{position:relative;margin:14px 16px 0;background:#000;border-radius:20px;overflow:hidden;cursor:pointer;
  box-shadow:0 0 0 1px rgba(201,168,106,.35),0 18px 50px rgba(0,0,0,.6)}
.vid video{width:100%;display:block;aspect-ratio:1/1;object-fit:contain;transition:transform .9s cubic-bezier(.22,.8,.3,1)}
.vid.close video{transform:scale(1.22)}
.vid .heart{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:50px;opacity:0;pointer-events:none;
  filter:drop-shadow(0 0 14px rgba(201,168,106,.9))}
.vid .heart.go{animation:hUp 1.2s ease-out}
@keyframes hUp{0%{opacity:0;transform:translate(-50%,-30%) scale(.6)}25%{opacity:1}
  100%{opacity:0;transform:translate(-50%,-150%) scale(1.15)}}
.vid .heard{position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#C9A86A;font-style:italic;font-size:14px;
  opacity:0;transition:.5s;text-shadow:0 2px 10px rgba(0,0,0,.8)}
.vid.close .heard{opacity:1}
.vid .hint{position:absolute;top:12px;left:0;right:0;text-align:center;color:rgba(244,235,221,.55);font-size:12px;
  letter-spacing:.5px;text-shadow:0 2px 8px rgba(0,0,0,.7)}
.vid .fs{position:absolute;bottom:12px;right:12px;background:rgba(20,16,13,.7);border:1px solid rgba(201,168,106,.5);
  color:#F4EBDD;font-size:12px;padding:6px 12px;border-radius:999px;cursor:pointer;font-family:Arial,sans-serif}
.info{text-align:center;padding:26px 22px 8px}
.info .nm{font-size:30px;letter-spacing:1px}
.info .dt{color:#C9A86A;font-size:13px;letter-spacing:2px;margin-top:6px}
.info .line{color:#cbb89a;font-style:italic;font-size:16px;line-height:1.6;margin-top:14px;padding:0 10px}
.sec{text-align:center;font-size:12px;letter-spacing:2px;color:#6f6455;text-transform:uppercase;margin:34px 0 16px}
.products{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:0 16px}
@media(max-width:520px){.products{grid-template-columns:1fr}}
.pc{background:#171310;border:1px solid rgba(201,168,106,.25);border-radius:18px;padding:22px 18px;text-align:center}
.pc.hot{border-color:rgba(201,168,106,.7);box-shadow:0 0 0 1px rgba(201,168,106,.3)}
.pc .emo{font-size:30px}
.pc .t{font-family:Georgia,serif;font-size:18px;margin:10px 0 4px}
.pc .pr{color:#C9A86A;font-size:22px;font-weight:600}
.pc .d{color:#9a9186;font-size:12px;margin:8px 0 16px;min-height:34px;line-height:1.6}
.pc a{display:block;background:linear-gradient(120deg,#B0894F,#a07c44);color:#fff;text-decoration:none;
  padding:13px;border-radius:12px;font-size:15px;font-weight:600;font-family:Arial,sans-serif}
.pc.hot a{background:linear-gradient(120deg,#2B2722,#000)}
.share{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;padding:0 16px}
.share a{display:inline-flex;align-items:center;gap:6px;padding:11px 18px;border-radius:12px;text-decoration:none;
  font-size:14px;font-family:Arial,sans-serif;border:1px solid rgba(201,168,106,.35);color:#F4EBDD}
.share a:hover{background:#1d1814}
.foot{text-align:center;color:#6f6455;font-size:12px;margin-top:44px;padding:0 16px}
</style></head><body>
<div class="top">Pet Memory · <b>their light, kept</b></div>

<div class="vid" id="vid">
  <video id="v" src="/data/videos/${p.id}.mp4" loop autoplay muted playsinline></video>
  <div class="heart" id="heart">💛</div>
  <div class="heard">…they heard you</div>
  <div class="hint">tap them — they’ll come closer</div>
  <div class="fs" id="fsBtn">⛶ fullscreen (for the box)</div>
</div>

<div class="info">
  <div class="nm">${esc(p.name)}</div>
  ${p.dates?`<div class="dt">${esc(p.dates)}</div>`:""}
  ${oneLine?`<div class="line">“${esc(oneLine)}”</div>`:""}
</div>

<div class="sec">Keep them close</div>
<div class="products">
  <div class="pc hot">
    <div class="emo">📦</div>
    <div class="t">The Holographic Box</div>
    <div class="pr">$19.90</div>
    <div class="d">Place your phone on top and ${esc(p.name)} appears in light, day or night.</div>
    <a href="https://petmenory.com/products/holographic-projection-box" target="_blank" rel="noopener">Get the box →</a>
  </div>
  <div class="pc">
    <div class="emo">🎬</div>
    <div class="t">Premium 15s Film</div>
    <div class="pr">$29.99</div>
    <div class="d">A longer, cinematic tribute — more moments, their full story, in light.</div>
    <a href="https://petmenory.com/products/custom-al-healing-memorialvideo-for-pet-cinematictribute-film" target="_blank" rel="noopener">Go premium →</a>
  </div>
</div>

<div class="sec">Share their light</div>
<div class="share">
  <a href="https://twitter.com/intent/tweet?url=${shareUrl}&text=${shareText}" target="_blank" rel="noopener">𝕏 Post</a>
  <a href="https://www.facebook.com/sharer/sharer.php?u=${shareUrl}" target="_blank" rel="noopener">Facebook</a>
  <a href="https://wa.me/?text=${shareText}%20${shareUrl}" target="_blank" rel="noopener">WhatsApp</a>
</div>

<div class="foot">Pet Memory · made with care, for the ones we miss.</div>

<script>
var v=document.getElementById('v'); v.play().catch(function(){});
document.getElementById('vid').addEventListener('click',function(e){
  if(e.target&&e.target.id==='fsBtn') return;
  var on=this.classList.toggle('close');
  if(on){ var h=document.getElementById('heart'); h.classList.remove('go'); void h.offsetWidth; h.classList.add('go');
    if(v.paused) v.play().catch(function(){}); }
});
document.getElementById('fsBtn').addEventListener('click',function(){
  var el=document.getElementById('vid');
  if(el.requestFullscreen){el.requestFullscreen()}else if(el.webkitRequestFullscreen){el.webkitRequestFullscreen()}
});
</script>
</body></html>`;
}

function waitingHTML(p){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} — Pet Memory</title><style>
body{margin:0;background:#14100d;color:#F4EBDD;font-family:Georgia,serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{text-align:center;padding:40px 26px;max-width:420px}
.avatar{width:150px;height:150px;border-radius:50%;overflow:hidden;margin:0 auto 22px;
  border:2px solid #B0894F;box-shadow:0 0 30px rgba(201,168,106,.4)}
.avatar img{width:100%;height:100%;object-fit:cover}
h1{font-size:26px;margin:0 0 10px;font-weight:600}
.candle{font-size:34px;display:block;margin-bottom:14px;animation:fl 2.4s ease-in-out infinite}
@keyframes fl{0%,100%{opacity:.75}50%{opacity:1}}
p{color:#C9A86A;line-height:1.7;margin:0 0 8px}
.dim{color:#8a7d6f;font-size:13px;margin-top:22px}
</style></head><body><div class="box">
<div class="avatar"><img src="/data/photos/${p.id}.jpg" alt=""></div>
<span class="candle">🕯️</span>
<h1>${esc(p.name)} is being lovingly crafted</h1>
<p>Their film is being made by hand, with care.<br>Usually ready in <b>5–15 minutes</b>.</p>
<p>This page refreshes itself — please check back shortly.<br>The moment it's ready, they'll appear here, in light.</p>
<div class="dim">Pet Memory · forever in our hearts</div>
</div><script>setTimeout(function(){location.reload()},30000);</script></body></html>`;
}

function adminHTML(pets,key){
  const rows=pets.map(p=>{
    const ready=p.status==="ready";
    const acts=(p.actions||[]).join(", ")||"—";
    const n=p.photoCount||1;
    const imgs=Array.from({length:n},(_,i)=>`<img src="/data/photos/${p.id}${i===0?"":"_"+i}.jpg">`).join("");
    const badge=p.free?`<span class="free">${p.tier==="premium"?"FREE→Premium":"FREE"}</span>`:"";
    return `<div class="job ${ready?'ready':''}">
      <div class="photos">${imgs}</div>
      <div class="meta">
        <b>${esc(p.name)}</b> ${p.type==="cat"?"🐱":"🐶"} ${badge} <span class="st ${ready?'ok':''}">${ready?"✓ Ready":"⏳ Pending"}</span><br>
        ${p.free?`<span>✉️ ${esc(p.email||"—")} · share:${p.share?"yes":"no"}</span><br>`:`<span>Order: ${esc(p.orderNumber||"—")}</span><br>`}
        ${p.oneLine?`<span>💬 ${esc(p.oneLine)}</span><br>`:""}
        ${p.letter?`<span>Letter: ${esc(p.letter)}</span><br>`:""}
        ${p.dates?`<span>Dates: ${esc(p.dates)}</span><br>`:""}
        ${p.story?`<span>📖 ${esc(p.story.slice(0,80))}${p.story.length>80?"…":""}</span><br>`:""}
        <span class="dim">${new Date(p.createdAt).toLocaleString()}</span>
        ${ready?`<div class="lnk">📦 <a href="/pet/${p.id}" target="_blank">/pet/${p.id}</a> (print QR to this page)</div>`:""}
        ${ready?"":`<div class="up"><input type="file" accept="video/mp4,video/webm" id="f_${p.id}">
        <button onclick="fulfill('${p.id}')">Upload film ✓</button><span class="msg" id="m_${p.id}"></span></div>`}
      </div>
    </div>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Merchant Console — Pet Memory</title><style>
body{margin:0;background:#FBF7F1;color:#2B2722;font-family:-apple-system,'Segoe UI',sans-serif}
.wrap{max-width:680px;margin:0 auto;padding:26px 16px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#7C736A;font-size:13px;margin-bottom:20px}
.job{display:flex;gap:14px;background:#fff;border:1px solid #EDE4D7;border-radius:14px;padding:14px;margin-bottom:12px}
.job.ready{opacity:.75}
.job img{width:88px;height:88px;object-fit:cover;border-radius:10px;flex:none;background:#111}
.photos{display:flex;gap:6px;flex:none;flex-wrap:wrap;max-width:190px}
.photos img{width:88px;height:88px}
.photos img:not(:first-child){width:48px;height:48px}
.meta{font-size:13px;line-height:1.7;flex:1}
.meta b{font-size:16px}
.st{background:#FBF1E2;color:#B0894F;padding:2px 9px;border-radius:999px;font-size:11px}
.st.ok{background:#E7F4E4;color:#3E7C3A}
.free{background:#EAF1FB;color:#2E5DA8;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.dim{color:#9a9186;font-size:11px}
.up{margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.up input{font-size:12px;max-width:200px}
button{background:#B0894F;color:#fff;border:none;padding:9px 16px;border-radius:10px;font-size:13px;cursor:pointer}
.msg{color:#3E7C3A;font-size:12px}
.lnk{margin-top:6px;font-size:12px}.lnk a{color:#B0894F}
.empty{color:#7C736A;text-align:center;padding:40px}
</style></head><body><div class="wrap">
<h1>🐾 Merchant Console</h1>
<div class="sub">Pending first. Generate each film in your WeChat mini-program, then upload the mp4 here — it goes live on the customer's page instantly.</div>
${rows||'<div class="empty">No orders yet.</div>'}
</div><script>
var KEY=${JSON.stringify(key)};
function fulfill(id){
  var f=document.getElementById('f_'+id).files[0];
  var m=document.getElementById('m_'+id);
  if(!f){m.textContent="pick a video first";return;}
  m.textContent="uploading…";
  var r=new FileReader();
  r.onload=function(){
    fetch("/api/fulfill",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({key:KEY,petId:id,video:r.result})})
    .then(function(x){return x.json()}).then(function(j){
      if(j.ok){m.textContent="✓ live now!";setTimeout(function(){location.reload()},800);}
      else m.textContent="error: "+(j.error||"");
    }).catch(function(e){m.textContent="network error";});
  };
  r.readAsDataURL(f);
}
</script></body></html>`;
}

const MIME={".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".mp4":"video/mp4",".webm":"video/webm"};
function serveFile(res,filePath){
  if(!fs.existsSync(filePath)){ res.writeHead(404); return res.end("not found"); }
  res.writeHead(200,{"Content-Type":MIME[path.extname(filePath).toLowerCase()]||"application/octet-stream",
    "Access-Control-Allow-Origin":"*","Cache-Control":"public, max-age=31536000"});
  fs.createReadStream(filePath).pipe(res);
}
function send(res,code,obj){
  res.writeHead(code,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"POST,GET,OPTIONS"});
  res.end(JSON.stringify(obj));
}

const server=http.createServer(async(req,res)=>{
  const url=req.url.split("?")[0];
  if(req.method==="OPTIONS") return send(res,200,{});
  if(req.method==="GET"&&url==="/api/health")
    return send(res,200,{ok:true,shop:!!SHOP_TOKEN,kling:!!klingAuth(),pets:readPets().length});
  if(req.method==="GET"&&url==="/api/pets")
    return send(res,200,{ok:true,pets:readPets().map(p=>({id:p.id,name:p.name,type:p.type,
      dates:p.dates||"",letter:p.letter||"",scene:p.scene||"warm",
      photoUrl:`/data/photos/${p.id}.jpg`,videoUrl:`/data/videos/${p.id}.mp4`,createdAt:p.createdAt}))});
  // public social-proof feed: ready films whose owners opted in to sharing (homepage "their stories")
  if(req.method==="GET"&&url==="/api/stories")
    return send(res,200,{ok:true,stories:readPets().filter(p=>p.status==="ready"&&p.share)
      .map(p=>({name:p.name,type:p.type,oneLine:p.oneLine||p.letter||"",dates:p.dates||"",
        videoUrl:`/data/videos/${p.id}.mp4`,petUrl:`/pet/${p.id}`}))});
  if(req.method==="GET"&&url==="/wall")
    return (res.writeHead(200,{"Content-Type":"text/html"}),res.end(wallHTML(readPets())));
  if(req.method==="GET"&&url.startsWith("/pet/")){
    const p=readPets().find(x=>x.id===url.slice(5));
    if(!p){res.writeHead(404,{"Content-Type":"text/html"});return res.end("not found");}
    const html=p.status==="ready"?petHTML(p):waitingHTML(p);
    return (res.writeHead(200,{"Content-Type":"text/html"}),res.end(html));
  }
  if(req.method==="GET"&&url==="/admin"){
    const key=(req.url.split("key=")[1]||"").split("&")[0];
    if(!ADMIN_KEY) return (res.writeHead(503,{"Content-Type":"text/html"}),res.end("ADMIN_KEY not configured"));
    if(key!==ADMIN_KEY) return (res.writeHead(403,{"Content-Type":"text/html"}),res.end("forbidden"));
    const pets=readPets().slice().sort((a,b)=>((a.status==="ready")-(b.status==="ready"))||b.createdAt-a.createdAt);
    return (res.writeHead(200,{"Content-Type":"text/html"}),res.end(adminHTML(pets,key)));
  }
  if(req.method==="GET"&&url.startsWith("/data/")) return serveFile(res,path.join(DATA,url.slice(6)));

  // customer submits a film (FREE tier: no order; PAID tier: verify order). Merchant crafts & uploads.
  if(req.method==="POST"&&url==="/api/submit"){
    let raw=""; req.on("data",c=>{raw+=c; if(raw.length>25e6)req.destroy();});
    req.on("end",async()=>{
      try{
        const b=JSON.parse(raw||"{}");
        const photosIn=Array.isArray(b.photos)&&b.photos.length?b.photos:(b.photo?[b.photo]:[]);
        if(!photosIn.length) return send(res,400,{error:"photo required"});
        const pets=readPets();

        // ---- FREE tier ----
        if(b.free){
          if(!b.email) return send(res,400,{error:"email required"});
          const em=String(b.email).trim().toLowerCase();
          const ex=pets.find(x=>x.free&&x.email===em);
          if(ex) return send(res,200,{ok:true,petId:ex.id,petUrl:`${PUBLIC_URL}/pet/${ex.id}`,wallUrl:`${PUBLIC_URL}/wall`,note:"already submitted"});
          if(!checkDailyLimit()) return send(res,429,{error:"Today's free spots are gone — please try again tomorrow."});
          const id=crypto.randomBytes(6).toString("hex");
          let photoCount=0;
          photosIn.slice(0,5).forEach((ph,i)=>{ if(saveDataUrl(ph,path.join(PHOTOS,id+(i===0?"":"_"+i)+".jpg"))) photoCount++; });
          if(!photoCount) return send(res,400,{error:"invalid photo data"});
          pets.unshift({id,name:String(b.name||"My friend").slice(0,60),type:b.type||"cat",
            oneLine:String(b.oneLine||"").slice(0,200),story:String(b.story||"").slice(0,1000),
            email:em,share:!!b.share,tier:b.tier==="premium"?"premium":"free",free:true,
            photoCount,status:"pending",createdAt:Date.now()});
          writePets(pets);
          return send(res,200,{ok:true,petId:id,petUrl:`${PUBLIC_URL}/pet/${id}`,wallUrl:`${PUBLIC_URL}/wall`,free:true});
        }

        // ---- PAID tier (order-verified) ----
        if(!b.orderNumber) return send(res,400,{error:"orderNumber required"});
        const v=await verifyOrder(b.orderNumber);
        if(!v.ok) return send(res,402,{error:v.reason});
        const existing=pets.find(x=>x.orderNumber===String(b.orderNumber).trim());
        if(existing) return send(res,200,{ok:true,petId:existing.id,petUrl:`${PUBLIC_URL}/pet/${existing.id}`,wallUrl:`${PUBLIC_URL}/wall`,note:"already submitted"});
        const id=crypto.randomBytes(6).toString("hex");
        let photoCount=0;
        photosIn.slice(0,5).forEach((ph,i)=>{
          if(saveDataUrl(ph,path.join(PHOTOS,id+(i===0?"":"_"+i)+".jpg"))) photoCount++;
        });
        if(!photoCount) return send(res,400,{error:"invalid photo data"});
        pets.unshift({id,name:String(b.name||"My friend").slice(0,60),type:b.type||"cat",
          dates:String(b.dates||"").slice(0,60),letter:String(b.letter||"").slice(0,300),
          scene:["warm","starry","sunset"].includes(b.scene)?b.scene:"warm",projection:!!b.projection,
          actions:Array.isArray(b.actions)?b.actions.slice(0,8):[],photoCount,
          orderNumber:String(b.orderNumber).trim(),status:"pending",createdAt:Date.now()});
        writePets(pets);
        return send(res,200,{ok:true,petId:id,petUrl:`${PUBLIC_URL}/pet/${id}`,wallUrl:`${PUBLIC_URL}/wall`});
      }catch(e){ return send(res,500,{error:e.message}); }
    });
    return;
  }

  // merchant uploads the finished film (generated in the WeChat mini-program)
  if(req.method==="POST"&&url==="/api/fulfill"){
    let raw=""; req.on("data",c=>{raw+=c; if(raw.length>60e6)req.destroy();});
    req.on("end",async()=>{
      try{
        const b=JSON.parse(raw||"{}");
        if(!ADMIN_KEY) return send(res,503,{error:"ADMIN_KEY not configured"});
        if(b.key!==ADMIN_KEY) return send(res,403,{error:"forbidden"});
        const pets=readPets();
        const p=pets.find(x=>x.id===b.petId);
        if(!p) return send(res,404,{error:"pet not found"});
        if(!saveVideoDataUrl(b.video,path.join(VIDEOS,p.id+".mp4"))) return send(res,400,{error:"invalid video"});
        // Transcode HEVC → H.264 so browsers (Chrome/Edge) can play it. WeChat mini-programs export HEVC by default.
        let transcoded=false, codecNote="";
        const codec=detectCodec(path.join(VIDEOS,p.id+".mp4"));
        if(codec==="hevc"){
          const ok=await transcodeToH264(path.join(VIDEOS,p.id+".mp4"));
          if(ok){ transcoded=true; codecNote=" (auto-converted from HEVC to H.264)"; }
          else { fs.unlinkSync(path.join(VIDEOS,p.id+".mp4")); return send(res,400,{error:"视频是 HEVC 编码，浏览器播不了。请在小程序里导出为 H.264 后再上传。"}); }
        }
        p.status="ready"; p.readyAt=Date.now(); p.codec=codec; p.transcoded=transcoded;
        writePets(pets);
        return send(res,200,{ok:true,petUrl:`${PUBLIC_URL}/pet/${p.id}`,note:transcoded?"视频已自动转码，浏览器可直接播放。":undefined});
      }catch(e){ return send(res,500,{error:e.message}); }
    });
    return;
  }

  if(req.method==="POST"&&url==="/api/generate"){
    let raw=""; req.on("data",c=>{raw+=c; if(raw.length>15e6)req.destroy();});
    req.on("end",async()=>{
      try{
        const b=JSON.parse(raw||"{}");
        if(!b.orderNumber) return send(res,400,{error:"orderNumber required"});
        if(!b.photo) return send(res,400,{error:"photo required"});
        const v=await verifyOrder(b.orderNumber);
        if(!v.ok) return send(res,402,{error:v.reason});
        const proj=!!b.projection;
        const prompt=buildPrompt(b.name,b.type,b.actions,b.scene,proj);
        const imgIn=await prepareImage(b.photo,proj);   // projection mode → cutout on true black
        const tempUrl=await klingVideoUrl(imgIn,prompt);

        const id=crypto.randomBytes(6).toString("hex");
        saveDataUrl(b.photo,path.join(PHOTOS,id+".jpg"));
        await downloadTo(tempUrl,path.join(VIDEOS,id+".mp4"));   // Kling URLs expire — store it
        const pets=readPets();
        pets.unshift({id,name:b.name||"My friend",type:b.type||"cat",
          dates:String(b.dates||"").slice(0,60),letter:String(b.letter||"").slice(0,300),
          scene:proj?"projection":(["warm","starry","sunset"].includes(b.scene)?b.scene:"warm"),
          createdAt:Date.now()});
        writePets(pets);
        return send(res,200,{ok:true,petId:id,
          videoUrl:`/data/videos/${id}.mp4`, wallUrl:`${PUBLIC_URL}/wall`, petUrl:`${PUBLIC_URL}/pet/${id}`});
      }catch(e){ return send(res,500,{error:e.message}); }
    });
    return;
  }
  send(res,404,{error:"not found"});
});
server.listen(PORT,()=>console.log(`Hologram backend on :${PORT} | wall: ${PUBLIC_URL}/wall`));
