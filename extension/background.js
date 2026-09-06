// Prism background — streaming search for Docs/Sheets/Slides/PDF
// Clean version: no paywall, no picker, no IndexedDB harvesting — just
// fetch + cache + stream snippets. Based on DocLens 1.0.6 background but
// extended to all file types via fetchSessionText (api.js).

importScripts("extract.js", "api.js");

const CACHE_TTL_MS = 60*60*1000;
const LICENSE_SERVER = 'https://prism-license-worker.purrapi.workers.dev';
const LICENSE_ALARM = 'prism-license-revalidate';
const LICENSE_RECHECK_PERIOD_MINUTES = 24 * 60;
const LICENSE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function scheduleLicenseRevalidation() {
  try { chrome.alarms.create(LICENSE_ALARM, { periodInMinutes: LICENSE_RECHECK_PERIOD_MINUTES }); } catch (_) {}
}

async function revalidateStoredLicense() {
  const stored = await new Promise((resolve) => chrome.storage.local.get(['prismPremium', 'prismLicenseKey'], resolve));
  if (!stored.prismPremium || !stored.prismLicenseKey) return;
  try {
    const response = await fetch(`${LICENSE_SERVER}/api/validate-license`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: stored.prismLicenseKey })
    });
    if (!response.ok) throw new Error(`license server ${response.status}`);
    const data = await response.json();
    if (!data.valid) {
      await chrome.storage.local.remove(['prismPremium', 'prismLicenseExpiresAt']);
      return;
    }
    const periodEnd = data.currentPeriodEnd ? Date.parse(data.currentPeriodEnd) : 0;
    await chrome.storage.local.set({
      prismPremium: true,
      prismLicenseValidatedAt: Date.now(),
      ...(periodEnd > 0 ? { prismLicenseExpiresAt: periodEnd + LICENSE_GRACE_MS } : {})
    });
  } catch (_) {}
}

try {
  chrome.runtime.onInstalled.addListener(scheduleLicenseRevalidation);
  chrome.runtime.onStartup.addListener(scheduleLicenseRevalidation);
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === LICENSE_ALARM) revalidateStoredLicense(); });
  scheduleLicenseRevalidation();
} catch (_) {}

// --- pdf.js offscreen for robust PDF extraction (MV3) ---
let offscreenReady = null;
async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      if (chrome.offscreen && chrome.offscreen.hasDocument) {
        const has = await chrome.offscreen.hasDocument();
        if (has) return;
      }
    } catch {}
    try {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'pdf.js text extraction' });
    } catch (e) {
      // already exists
      if (!String(e.message||'').includes('Only a single')) throw e;
    }
  })();
  return offscreenReady;
}
let _pdfReqId = 0;
async function pdfTextViaOffscreen(buffer) {
  await ensureOffscreen();
  const data = Array.from(new Uint8Array(buffer));
  const id = ++_pdfReqId;
  const resp = await chrome.runtime.sendMessage({ type: 'PRISM_PDF_EXTRACT', id, data });
  if (resp && resp.ok) return resp.text || '';
  throw new Error(resp && resp.error || 'pdf offscreen failed');
}
// Wrap original custom pdfText with pdf.js first, fallback to custom
const _customPdfText = pdfText;
pdfText = async function(buffer) {
  try {
    const t = await pdfTextViaOffscreen(buffer);
    if (t && t.trim().length > 20) {
      console.log(`[Prism:extract] pdf.js offscreen extracted ${t.length} chars`);
      return t;
    }
    console.log('[Prism:extract] pdf.js returned empty, fallback to custom parser');
  } catch (e) {
    console.warn('[Prism:extract] pdf.js offscreen error, fallback', e.message);
  }
  return _customPdfText(buffer);
};

chrome.runtime.onConnect.addListener((port)=>{
  if(port.name !== 'search-docs-stream') return;
  port.onMessage.addListener((msg)=>{
    if(msg.type !== 'SEARCH_DOCS') return;
    console.log(`[Prism:bg] SEARCH_DOCS query="${msg.query}" docs=${msg.docs.length}`);
    handleSearchStreaming(msg.docs, msg.query, port).catch(err=>{
      console.warn('[Prism:bg] streaming error', err);
      safePortPostMessage(port,{type:'SEARCH_ERROR', error: err.message});
    });
  });
});

// One-time cache purge: remove ALL stale cache entries (force fresh re-fetch with correct mime)
try {
  chrome.storage.local.get(null, (all) => {
    const keys = Object.keys(all).filter(k => k.startsWith('doc_'));
    if (keys.length) {
      console.log(`[Prism:bg] purging ${keys.length} old cache entries for fresh start`);
      chrome.storage.local.remove(keys);
    }
  });
} catch(e) {}

function safePortPostMessage(port, msg){
  try{ port.postMessage(msg); }catch{}
}

function isLikelyGoogleDocId(id){
  if(!id || typeof id !== 'string') return false;
  const n=id.trim();
  if(!n || n.length<25 || n.length>50) return false;
  if(!/^[a-zA-Z0-9-_]+$/.test(n)) return false;
  if(/^(jfk|quantumwiz|appselements|docs-homescreen|javascriptmaterialdesign|searchboxtextahead|startup|amdaw|afqj|AKfyc)/i.test(n)) return false;
  return /\d/.test(n) || /[A-Z]/.test(n);
}

async function handleSearchStreaming(docs, query, port){
  if(!query || !docs || docs.length===0){ safePortPostMessage(port,{type:'SEARCH_COMPLETE'}); return; }
  console.log(`[Prism:bg] start streaming query="${query}" docs=${docs.length} sample=${docs.slice(0,2).map(d=>d.id.slice(0,8)+':'+(d.title||'').slice(0,20)).join(',')}`);
  // Keep SW alive while streaming (Chrome kills idle SW after ~30s, binary PDF fetch can take longer)
  let keepAlive=null;
  try{ keepAlive=setInterval(()=>{ try{ chrome.runtime.getPlatformInfo(()=>{}); }catch{} }, 20000); }catch{}
  port.onDisconnect.addListener(()=>{ if(keepAlive) clearInterval(keepAlive); keepAlive=null; });
  const BATCH_SIZE=5;
  let processed=0;
  try{
  for(let i=0;i<docs.length;i+=BATCH_SIZE){
    const batch=docs.slice(i,i+BATCH_SIZE);
    console.log(`[Prism:bg] batch ${i/BATCH_SIZE+1} start ${batch.map(d=>d.id.slice(0,8)).join(',')}`);
    const batchPromises = batch.map(async (doc)=>{
      try{
        if(!isLikelyGoogleDocId(doc.id)){ console.log('[Prism:bg] skip invalid', doc.id.slice(0,8)); return {hit:null, id:doc.id}; }
        const text=await getDocumentText(doc.id, doc.mimeType||'', doc.title||'');
        if(!text || !text.text){
          // still check title match even if no extractable body text (e.g., scanned PDF)
          const termRaw = query.trim(); const qm = termRaw.match(/^"(.+)"$/)||termRaw.match(/^'(.+)'$/); const term = (qm && qm[1].trim())?qm[1].trim():termRaw;
          const titleHit = term && (doc.title||'').toLowerCase().includes(term.toLowerCase());
          if (titleHit) {
            const hitMime = (doc.mimeType||'').toLowerCase().includes('pdf') ? 'application/pdf' : (doc.mimeType||'');
            const snippet={uiText: doc.title, exactText: doc.title, matchOffset:0, keyword: term, isTitleMatch:true, beforeSentence:'', afterSentence:''};
            console.log(`[Prism:bg] HIT-TITLE ${doc.id.slice(0,8)} "${(doc.title||'').slice(0,30)}"`);
            const hit={id:doc.id, title:doc.title||'Untitled', mimeType: hitMime, snippets:[snippet]};
            processed++; safePortPostMessage(port,{type:'BATCH_RESULTS', results:[hit], processed, total: docs.length}); return {hit, id:doc.id};
          }
          console.log(`[Prism:bg] no text ${doc.id.slice(0,8)} "${(doc.title||'').slice(0,30)}"`); return {hit:null, id:doc.id};
        }
        let snippets=extractSnippets(text.text, query, text.mimeType);
        // also match title
        const termRaw2 = query.trim(); const qm2 = termRaw2.match(/^"(.+)"$/)||termRaw2.match(/^'(.+)'$/); const term2 = (qm2 && qm2[1].trim())?qm2[1].trim():termRaw2;
        const titleLower=(doc.title||'').toLowerCase(); const termLower2=term2.toLowerCase();
        let titleSnippet=null;
        if (term2 && titleLower.includes(termLower2)) {
          titleSnippet={uiText: doc.title, exactText: doc.title, matchOffset:0, keyword: term2, isTitleMatch:true, beforeSentence:'', afterSentence:''};
          // de-dupe if body already contains title
          if (!snippets.some(s=> (s.exactText||'').toLowerCase()===titleLower)) snippets = [titleSnippet, ...snippets];
        }
        if(snippets.length>0){
          const hintIsPdf = (doc.mimeType||'').toLowerCase().includes('pdf');
          const hitMime = hintIsPdf ? 'application/pdf' : (text.mimeType || doc.mimeType || '');
          console.log(`[Prism:bg] HIT ${doc.id.slice(0,8)} "${(doc.title||'').slice(0,30)}" mime="${hitMime}" (text.mime="${text.mimeType}" doc.mime="${doc.mimeType}") ${snippets.length}${titleSnippet?' title-match':''} sample="${snippets[0].uiText.slice(0,60)}"`);
          const hit={id:doc.id, title:doc.title||'Untitled', mimeType: hitMime, snippets};
          processed++;
          safePortPostMessage(port,{type:'BATCH_RESULTS', results:[hit], processed, total: docs.length});
          return {hit, id:doc.id};
        } else {
          console.log(`[Prism:bg] MISS ${doc.id.slice(0,8)} len=${text.text.length} mime=${text.mimeType} sample="${text.text.slice(0,80).replace(/\s+/g,' ')}"`);
          processed++;
          safePortPostMessage(port,{type:'BATCH_RESULTS', results:[], processed, total: docs.length});
          return {hit:null, id:doc.id};
        }
      }catch(e){ console.warn(`[Prism:bg] doc ${doc.id.slice(0,8)} failed`, e.message, e.stack?.slice(0,200)); processed++; safePortPostMessage(port,{type:'BATCH_RESULTS', results:[], processed, total: docs.length}); return {hit:null, id:doc.id}; }
    });
    await Promise.all(batchPromises);
    console.log(`[Prism:bg] batch ${i/BATCH_SIZE+1} done processed=${processed}/${docs.length}`);
  }
  } finally { if(keepAlive) clearInterval(keepAlive); }
  console.log('[Prism:bg] DONE', query);
  safePortPostMessage(port,{type:'SEARCH_COMPLETE'});
}

async function getDocumentText(docId, hintMime='', hintName=''){
  const key=`doc_${docId}`;
  let cached=await new Promise(r=> chrome.storage.local.get([key], o=> r(o[key])));
  const now=Date.now();
  if(cached && (now - cached.timestamp < CACHE_TTL_MS)){
    // If cached entry has empty mimeType or mismatched pdf mime, invalidate it — stale from before fix
    const hintIsPdf = (hintMime||'').toLowerCase().includes('pdf') || (hintName||'').toLowerCase().endsWith('.pdf');
    const cachedIsPdf = (cached.mimeType||'').toLowerCase().includes('pdf');
    if(!cached.mimeType || (hintIsPdf && !cachedIsPdf)){
      console.log(`[Prism:bg] cache HIT but stale mime (cached=${cached.mimeType} hint=${hintMime}), invalidating ${docId.slice(0,8)}`);
      chrome.storage.local.remove(key);
      cached=null;
    } else {
      console.log(`[Prism:bg] cache HIT ${docId.slice(0,8)} age=${((now-cached.timestamp)/1000|0)}s mime=${cached.mimeType}`);
      return {text: cached.text, mimeType: cached.mimeType||''};
    }
  }
  const mime=(hintMime||'').toLowerCase();
  const nameLower=(hintName||'').toLowerCase();
  const isUnknown = !mime;
  const isPdfHint=mime.includes('pdf') || nameLower.endsWith('.pdf') || (isUnknown && /timetable|result|\bwaec\b/i.test(hintName));
  const isOfficeHint=mime.includes('officedocument') || mime.includes('openxml') || /\.(docx|xlsx|pptx|doc|xls|ppt)$/i.test(nameLower);
  const skipExport = isPdfHint || isOfficeHint;
  console.log(`[Prism:bg] fetch ${docId.slice(0,8)} mime=${hintMime} name="${(hintName||'').slice(0,40)}" skipExport=${skipExport} isUnknown=${isUnknown}`);

  // Fast path for native Google types — try correct export first, like original did
  const tryExport=async (url)=>{
    try{
      const res=await fetch(url, {credentials:'include', signal: AbortSignal.timeout(8000)});
      if(!res.ok){ console.log(`[Prism:bg] export miss ${url.slice(0,70)} -> ${res.status}`); return null; }
      const ct=res.headers.get('content-type')||'';
      if(ct.includes('text/html')) return null;
      const txt=await res.text();
      if(!txt || txt.trimStart().startsWith('<') || txt.includes('accounts.google.com') || txt.includes('ServiceLogin')) return null;
      if(!txt.trim()) return null;
      return txt;
    }catch(e){ console.log(`[Prism:bg] export error ${url.slice(0,60)}`, e.message); return null; }
  };

  let text=null, detectedMime=hintMime;
  if(!skipExport){
    // Ordered tries based on hint to avoid duplicate fetches
    const tries=[];
    if(mime.includes('spreadsheet')||mime.includes('sheet')||mime.includes('csv')||mime.includes('excel')){
      tries.push({url:`https://docs.google.com/spreadsheets/d/${docId}/export?format=csv`, mime:'application/vnd.google-apps.spreadsheet'});
      tries.push({url:`https://docs.google.com/document/d/${docId}/export?format=txt`, mime:'application/vnd.google-apps.document'});
      tries.push({url:`https://docs.google.com/presentation/d/${docId}/export?format=txt`, mime:'application/vnd.google-apps.presentation'});
      tries.push({url:`https://docs.google.com/presentation/d/${docId}/export/txt`, mime:'application/vnd.google-apps.presentation'});
    } else if(mime.includes('presentation')||mime.includes('slide')){
      tries.push({url:`https://docs.google.com/presentation/d/${docId}/export?format=txt`, mime:'application/vnd.google-apps.presentation'});
      tries.push({url:`https://docs.google.com/presentation/d/${docId}/export/txt`, mime:'application/vnd.google-apps.presentation'});
      tries.push({url:`https://docs.google.com/document/d/${docId}/export?format=txt`, mime:'application/vnd.google-apps.document'});
      tries.push({url:`https://docs.google.com/spreadsheets/d/${docId}/export?format=csv`, mime:'application/vnd.google-apps.spreadsheet'});
    } else {
      tries.push({url:`https://docs.google.com/document/d/${docId}/export?format=txt`, mime:'application/vnd.google-apps.document'});
      tries.push({url:`https://docs.google.com/spreadsheets/d/${docId}/export?format=csv`, mime:'application/vnd.google-apps.spreadsheet'});
      tries.push({url:`https://docs.google.com/presentation/d/${docId}/export?format=txt`, mime:'application/vnd.google-apps.presentation'});
      tries.push({url:`https://docs.google.com/presentation/d/${docId}/export/txt`, mime:'application/vnd.google-apps.presentation'});
    }
    for(const t of tries){
      if(text) break;
      const got=await tryExport(t.url);
      if(got){ text=got; detectedMime=t.mime; }
    }
  } else {
    console.log(`[Prism:bg] skip export for office/pdf ${docId.slice(0,8)}, go direct to binary`);
  }

  // helper to save without throwing on quota — skip large docs (>80k) to avoid quota
  async function safeSetCache(k, v){
    if(v.text && v.text.length > 80000){
      console.log(`[Prism:bg] skip cache for large ${k.slice(0,12)} len=${v.text.length}`);
      return;
    }
    try{
      await new Promise((resolve)=>{
        chrome.storage.local.set({[k]: v}, ()=>{
          if(chrome.runtime.lastError){
            const msg=chrome.runtime.lastError.message||'';
            console.warn(`[Prism:bg] cache set failed ${k.slice(0,12)}`, msg);
            if(msg.includes('QUOTA')||msg.includes('quota')||msg.includes('QUOTA_BYTES')){
              chrome.storage.local.get(null, (all)=>{
                const docKeys=Object.keys(all).filter(x=>x.startsWith('doc_')).sort((a,b)=>(all[a]?.timestamp||0)-(all[b]?.timestamp||0));
                const toRemove=docKeys.slice(0, Math.max(10, Math.floor(docKeys.length*0.4)));
                console.log(`[Prism:bg] evicting ${toRemove.length} old cache entries`);
                if(toRemove.length) chrome.storage.local.remove(toRemove, ()=> {
                  // retry without text if still fails, just store tiny placeholder
                  chrome.storage.local.set({[k]: v}, ()=>{
                    if(chrome.runtime.lastError) console.warn('[Prism:bg] retry still failed', chrome.runtime.lastError.message);
                    resolve();
                  });
                });
                else resolve();
              });
            } else resolve();
          } else resolve();
        });
      });
    }catch(e){ console.warn('[Prism:bg] safeSetCache error', e.message); }
  }

  if(!text) console.log(`[Prism:bg] export gave no text for ${docId.slice(0,8)}, trying binary fallback hintMime="${hintMime}"`);
  // 3) still nothing — binary fallback: we've already tried exports above, go straight to drive.usercontent
  if(!text){
    try{
      console.log(`[Prism:bg] binary start ${docId.slice(0,8)} skipProbes=true (exports already tried)`);
      const fetched=await fetchSessionText(docId, hintMime||'', hintName||'', true);
      if(fetched && fetched.text && fetched.text.trim()){
        await safeSetCache(key, {text: fetched.text, timestamp: now, mimeType: fetched.mimeType});
        console.log(`[Prism:bg] fetched via binary ${docId.slice(0,8)} mime=${fetched.mimeType} len=${fetched.text.length}`);
        return {text: fetched.text, mimeType: fetched.mimeType};
      } else {
        console.log(`[Prism:bg] binary returned empty/whitespace for ${docId.slice(0,8)}, fetched=${!!fetched} textLen=${fetched?.text?.length||0}`);
      }
    }catch(e){ console.log(`[Prism:bg] binary fallback failed ${docId.slice(0,8)}`, e.message); }
  } else {
    const isSheet=detectedMime.includes('sheet')||detectedMime.includes('spreadsheet');
    const cleaned=isSheet? text : text.replace(/\[[a-z]{1,4}\]/g,'');
    const finalText=cleaned;
    await safeSetCache(key, {text: finalText, timestamp: now, mimeType: detectedMime});
    console.log(`[Prism:bg] fetched via export ${docId.slice(0,8)} mime=${detectedMime} len=${finalText.length}`);
    return {text: finalText, mimeType: detectedMime};
  }

  if(cached){ console.log(`[Prism:bg] fallback stale cache ${docId.slice(0,8)}`); return {text: cached.text, mimeType: cached.mimeType||''}; }
  console.log(`[Prism:bg] no text for ${docId.slice(0,8)}`);
  return null;
}

// ——— Snippet extraction (exact phrase, 80 char window) ———
function stripAppendedComments(text){
  const m=text.match(/^\[[a-z]{1,4}\]\S/m);
  if(!m) return text;
  return text.substring(0,m.index);
}
function stripInlineCommentMarkers(text){ return text.replace(/\[[a-z]{1,4}\]/g,''); }

function extractSnippets(text, query, mimeHint){
  if(!text||!query) return [];
  const trimmed=query.trim();
  const qm=trimmed.match(/^"(.+)"$/)||trimmed.match(/^'(.+)'$/);
  const term=(qm && qm[1].trim().length>0)?qm[1].trim():trimmed;
  if(!term) return [];
  let normalized=text.replace(/\r\n/g,'\n');
  normalized=stripInlineCommentMarkers(stripAppendedComments(normalized));
  const isSheet = mimeHint && /spreadsheet|sheet|csv|excel/i.test(mimeHint);
  // Sheet: one search term per view — header bolded + row before/after
  if(isSheet){
    const rows = normalized.split('\n').filter(r=>r.trim()!=="");
    if(rows.length===0) return [];
    const header = rows[0];
    const termLower=term.toLowerCase();
    const snippets=[];
    for(let i=1;i<rows.length && snippets.length<50;i++){
      const row = rows[i];
      if(!row.toLowerCase().includes(termLower)) continue;
      const before = i>1 ? rows[i-1] : '';
      const after = i+1 < rows.length ? rows[i+1] : '';
      // uiText for display: header (bolded in UI) + before + matched + after, tab→ comma for readability
      const toDisplay = (s)=> s.replace(/\t/g, ' · ');
      let uiText = toDisplay(header);
      if(before) uiText += '\n' + toDisplay(before);
      uiText += '\n' + toDisplay(row);
      if(after) uiText += '\n' + toDisplay(after);
      // matchOffset as row start for paging
      let offset=0; for(let k=0;k<i;k++) offset+=rows[k].length+1;
      snippets.push({uiText, exactText: row, matchOffset: offset, keyword: term, header, rowIndex: i, before, after});
    }
    return snippets;
  }
  const snippets=[];
  const seen=new Set();
  const termLower=term.toLowerCase();
  // Snap a [start,end) window out to word boundaries so snippets never cut a word in half
  // (never eats into the matched term itself, which spans [termStart, termEnd))
  const snapToWords=(text,start,end,termStart,termEnd)=>{
    if(start>0){
      while(start<termStart && !/\s/.test(text[start]) && !/\s/.test(text[start-1])) start++;
      while(start<termStart && /\s/.test(text[start])) start++;
    }
    if(end<text.length){
      while(end>termEnd && !/\s/.test(text[end]) && !/\s/.test(text[end-1])) end--;
      while(end>termEnd && /\s/.test(text[end-1])) end--;
    }
    return [start,end];
  };
  let idx=normalized.toLowerCase().indexOf(termLower);
  // Sentence index — spans of sentences/lines so previews can show one sentence before/after
  const sentSpans=[];
  {
    let sStart=0;
    for(let i=0;i<normalized.length;i++){
      const ch=normalized[i];
      if(ch==='.'||ch==='!'||ch==='?'){
        let j=i+1;
        while(j<normalized.length && '.!?'.includes(normalized[j])) j++;
        if(j>=normalized.length || /\s/.test(normalized[j])){
          if(j>sStart) sentSpans.push([sStart,j]);
          while(j<normalized.length && /\s/.test(normalized[j])) j++;
          sStart=j; i=j-1;
        }
      } else if(ch==='\n'){
        if(i>sStart) sentSpans.push([sStart,i]);
        sStart=i+1;
      }
    }
    if(sStart<normalized.length) sentSpans.push([sStart,normalized.length]);
  }
  const trimCtx=(t,keepEnd)=>{
    if(t.length<=220) return t;
    if(keepEnd){ const cut=t.slice(-220); const sp=cut.search(/\s/); return '…'+(sp===-1?cut:cut.slice(sp+1)); }
    const cut=t.slice(0,220); const sp=cut.lastIndexOf(' '); return (sp===-1?cut:cut.slice(0,sp))+'…';
  };
  const findSpan=(pos)=>{
    for(const span of sentSpans){ if(pos>=span[0]&&pos<span[1]) return span; }
    return null;
  };
  while(idx!==-1 && snippets.length<100){
    if(!seen.has(idx)){
      seen.add(idx);
      // Sentence containing the match, plus one sentence before and one after
      const span=findSpan(idx)||[idx,Math.min(normalized.length,idx+term.length)];
      let [s,e]=span;
      let sentence=normalized.substring(s,e).replace(/\s+/g,' ').trim();
      if(e-s>320){
        let [ts,te]=snapToWords(normalized,Math.max(s,idx-150),Math.min(e,idx+term.length+150),idx,idx+term.length);
        sentence=(ts>s?'…':'')+normalized.substring(ts,te).replace(/\s+/g,' ').trim()+(te<e?'…':'');
      }
      sentence=sentence.replace(/^\s*(\d+[.)]|[-•*])\s+/,'');
      const prevSpan=sentSpans[sentSpans.indexOf(span)-1];
      const nextSpan=sentSpans[sentSpans.indexOf(span)+1];
      const before=prevSpan?trimCtx(normalized.substring(prevSpan[0],prevSpan[1]).replace(/\s+/g,' ').trim(),true):'';
      const after=nextSpan?trimCtx(normalized.substring(nextSpan[0],nextSpan[1]).replace(/\s+/g,' ').trim(),false):'';
      snippets.push({uiText:[before,sentence,after].filter(Boolean).join(' '), exactText:sentence, beforeSentence:before, afterSentence:after, matchOffset:idx, keyword:normalized.substring(idx,idx+term.length)});
    }
    idx=normalized.toLowerCase().indexOf(termLower, idx+term.length);
  }
  snippets.sort((a,b)=>a.matchOffset-b.matchOffset);
  return snippets;
}

const bgSheetGidCache = new Map();
async function getSheetGidFromBackground(id){
  if(bgSheetGidCache.has(id)) return bgSheetGidCache.get(id);
  try{
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/edit`, {credentials:'include'});
    const html = await res.text();
    let m = html.match(/"gid"\s*:\s*"?(\d+)"?/) || html.match(/gid=(\d+)/) || html.match(/sheetId"\s*:\s*(\d+)/);
    let gid = m ? m[1] : '0';
    if(gid==='0'){
      const m2 = html.match(/\["[^"]*",\d+,\d+,\d+,\[(\d+)\]/);
      if(m2) gid = m2[1];
    }
    bgSheetGidCache.set(id, gid);
    console.log(`[Prism:bg] getSheetGid ${id.slice(0,8)} -> ${gid}`);
    return gid;
  }catch(e){ console.warn('[Prism:bg] getSheetGid failed', e.message); return '0'; }
}

// Keep service worker alive for streaming — no other listeners needed.
// Old drivelens messages (harvest-visible, index-single-url, etc.) removed.
// Content-doc deep linking still handled via openMatch helper if needed:
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(!msg) return false;
  if(msg.type==='GET_SHEET_GID'){
    getSheetGidFromBackground(msg.id).then(gid=>sendResponse({gid})).catch(()=>sendResponse({gid:'0'}));
    return true;
  }
  if(msg.type==='open-match'){
    openMatch(msg.fileId, msg.snippet).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:e.message}));
    return true;
  }
  if(msg.type==='CLEAR_CACHE'){
    chrome.storage.local.clear(()=>sendResponse({success:true}));
    return true;
  }
  if(msg.type==='GET_CACHE_INFO'){
    chrome.storage.local.get(null,(data)=>{
      const n=Object.keys(data).filter(k=>k.startsWith('doc_')).length;
      sendResponse({success:true, count:n});
    });
    return true;
  }
  return false;
});
async function openMatch(fileId, snippet){
  // Docs: use native find-text deep link. Sheets/Slides/PDF: just open.
  const key=`doc_${fileId}`;
  const cached=await new Promise(r=> chrome.storage.local.get([key], o=>r(o[key])));
  // Try to infer doc from cached? fallback to doc URL
  let isDoc=true;
  if(cached && cached.mimeType) isDoc=(cached.mimeType||'').toLowerCase().includes('document');
  if(isDoc && snippet){
    const phrase=snippet.replace(/…/g,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,10).join(' ');
    await chrome.tabs.create({url:`https://docs.google.com/document/d/${fileId}/edit#find-text=${encodeURIComponent(phrase)}`});
    return;
  }
  // For sheets/slides/pdf we need mime — fetch quickly or use generic
  await chrome.tabs.create({url:`https://drive.google.com/file/d/${fileId}/view`});
}
