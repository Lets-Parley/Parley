import { useEffect, useRef, useState } from "react";
import { ApiError, api, errorText, type Envelope } from "../lib/api";
import { Modal, buttonPrimary, buttonQuiet, inputClass } from "./Modal";

type Binding = { Destination: string; IssueType: string; ParentID: string; ParentDisposition: string; ProjectID: string; FieldID: string; Mapping: Record<string,string> };
type Step = { key: string; kind: string; childId?: string; blockerId?: string; dependentId?: string; title?: string; body?: string; value?: string; waiting?: boolean };
type Review = { ID: string; Fingerprint: string; Binding: Binding; Steps: Step[]; receipts?:Receipt[] };
type Receipt = Step & {state:string;remoteId?:string;attempts:number};
type Previous = {id:string;parentId:string};
type Connection = {available:boolean;binding:Binding|null;writeConsent:boolean};
const target = "min-h-11 break-words";
const stateText:Record<string,string> = {
 "local-only":"Local only — review before publication",
 "waiting-for-issues":"Waiting — include the missing sibling or leave this dependency pending",
 pending:"Pending — review and retry this step",
 confirmed:"Confirmed",
 failed:"Failed — check access and mapping, then review again",
 unknown:"Unknown — refresh receipts before retrying; the write may have reached GitHub",
};

export function SplitPublication({env}: {env:Envelope}) {
 const [open,setOpen]=useState(false);
 return <>
  <button type="button" className={`${buttonQuiet} ${target}`} onFocus={event=>{
   const button=event.currentTarget;
   requestAnimationFrame(()=>{
    if(!button.isConnected||document.activeElement!==button)return;
    const tray=document.querySelector<HTMLElement>("[data-poker-hand]");
    const bottom=tray&&getComputedStyle(tray).position==='fixed'?Math.min(innerHeight,tray.getBoundingClientRect().top):innerHeight;
    const rect=button.getBoundingClientRect();
    if(rect.bottom>bottom-16)window.scrollBy({top:rect.bottom-bottom+16,behavior:'instant'});
    else if(rect.top<16)window.scrollBy({top:rect.top-16,behavior:'instant'});
   });
  }} onClick={()=>setOpen(true)}>Publish splits to GitHub</button>
  {open&&<PublicationReview env={env} onClose={()=>setOpen(false)} />}
 </>;
}

function PublicationReview({env,onClose}:{env:Envelope;onClose:()=>void}) {
 const root=`/api/sessions/${env.id}/publication`;
 const parents=env.state.stories.filter(s=>s.planningRole==="context"&&!s.parentId&&!s.removedAt);
 const [parentId,setParentId]=useState(parents[0]?.id??"");
 const parent=parents.find(s=>s.id===parentId);
 const children=env.state.stories.filter(s=>s.parentId===parentId&&s.planningRole==="planning"&&!s.removedAt);
 const [selected,setSelected]=useState<string[]>(children.map(s=>s.id));
 const [connection,setConnection]=useState<Connection|null>(null);
 const [settings,setSettings]=useState(false);
 const [review,setReview]=useState<Review|null>(null);
 const [consent,setConsent]=useState(false);
 const [reviewId,setReviewId]=useState("");
 const [receipts,setReceipts]=useState<Receipt[]>([]);
 const [previous,setPrevious]=useState<Previous[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [config,setConfig]=useState({owner:"",repository:"",parentId:"",projectId:"",fieldId:"",token:"",readConsent:false,writeConsent:false});
 const name=(id?:string)=>{const s=env.state.stories.find(s=>s.id===id);return s?`${s.title} · ID ${s.id}`:`Unavailable sibling · ID ${id??"unknown"}`;};
 const snapshot=JSON.stringify([env.state.stories.map(s=>[s.id,s.title,s.notes,s.contentRevision,s.scopeRevision,s.planningRole,s.estimate,s.estimateNeedsReview,s.removedAt]),env.state.dependencies,env.state.deck]);
 function reportError(e:unknown){
  setError(errorText(e));setReview(null);setConsent(false);
  if(e instanceof ApiError&&[401,403,404].includes(e.status)){
   setConnection(null);setReviewId("");setReceipts([]);setPrevious([]);setSettings(false);setConfig(c=>({...c,token:""}));
  }
 }
 const previousSnapshot=useRef(snapshot);
 useEffect(()=>{
  if(previousSnapshot.current!==snapshot){previousSnapshot.current=snapshot;setReview(null);setConsent(false);setNotice("Split changed; review the latest payload before publishing.");}
 },[snapshot]);
 useEffect(()=>{
  let live=true;
  void api<Connection>("GET",root+"/connection").then(value=>{if(live){setConnection(value);setSettings(!value.binding);}}).catch(e=>{if(live)reportError(e);});
  void api<Previous[]>("GET",root+"/reviews").then(value=>{if(live)setPrevious(value);}).catch(()=>{});
  return ()=>{live=false;};
 },[root]);
 const invalidate=()=>{setReview(null);setConsent(false);setReviewId("");setReceipts([]);};
 async function perform(task:()=>Promise<void>) {
  setBusy(true);setError("");setNotice("");
  try{await task();}catch(e){reportError(e);}finally{setBusy(false);}
 }
 async function loadReceipts(id:string){setReceipts(await api<Receipt[]>("GET",`${root}/reviews/${id}/receipts`));}
 async function publish(){
  if(!review||!consent)return;
  await perform(async()=>{
   const approved=await api<Review>("POST",root+"/approve",{parentId,children:selected,fingerprint:review.Fingerprint,writeConsent:true});
   setReviewId(approved.ID);setConsent(false);
   try{await api("POST",`${root}/reviews/${approved.ID}/run`,{writeConsent:true});}
   finally{await loadReceipts(approved.ID);setPrevious(await api<Previous[]>("GET",root+"/reviews"));}
   setNotice("Publication run finished. Each receipt describes only its own step.");
  });
 }
 const pending=(env.state.dependencies??[]).filter(e=>e.parentId===parentId&&!e.retiredAt&&selected.includes(e.dependentId)&&!selected.includes(e.blockerId));
 return <Modal title="Review GitHub publication" onClose={onClose} width="44rem" opaque>
  <div className="space-y-5 text-ink [overflow-wrap:anywhere]">
   <p>This optional handoff publishes ordinary independent GitHub issues. It sends only the reviewed titles and refinement. Parent text and votes are omitted.</p>
   <p>GitHub has no conditional field update. Fresh preflight and readback bound the check; an upstream change can still race a write. Enabled automation can change fields later.</p>
   {connection?.available===false&&<p role="status">Ask the operator to configure PLUGIN_SECRET_KEY for encrypted credentials. Manual export remains available.</p>}
   {connection?.binding&&<div>
    <p>Stored connection: {connection.binding.Destination}. Access is checked again before review and every write. {connection.writeConsent?"Write permission allowed after exact payload approval.":"Metadata reads only; replace this connection to permit reviewed writes."}</p>
    <div className="flex flex-wrap gap-2">
     <button type="button" disabled={busy||env.endedAt!==null} className={`${buttonQuiet} ${target}`} onClick={()=>{invalidate();setSettings(true);}}>Replace connection</button>
     <button type="button" disabled={busy} className={`${buttonQuiet} ${target}`} onClick={()=>void perform(async()=>{await api("DELETE",root+"/connection");setConnection({...connection,binding:null});invalidate();setSettings(true);setNotice("Credential removed. Existing operation identities and receipts remain local.");})}>Revoke connection</button>
    </div>
   </div>}
   {settings&&connection?.available&&env.endedAt===null&&<form className="space-y-3" onSubmit={event=>{event.preventDefault();void perform(async()=>{
    try{await api("POST",root+"/connection",config);setConnection(await api<Connection>("GET",root+"/connection"));setSettings(false);invalidate();setNotice("Chosen repository, parent and Project field verified. Review the payload before publishing.");}
    finally{setConfig(c=>({...c,token:""}));}
   });}}>
    <h3 className="text-lg font-semibold">Connect this room and account</h3>
    <p>Use a dedicated PAT scoped to the chosen repository and Project, with Issues read/write and Project write access. The token is stored encrypted for your account in this room; it is never returned. No remote issue text is imported.</p>
    {([['owner','GitHub owner'],['repository','Repository'],['parentId','Native parent issue number'],['projectId','Project node ID'],['fieldId','NUMBER field node ID'],['token','Personal access token']] as const).map(([key,label])=><label key={key} className="block">{label}<input required className={`${inputClass} min-h-11 w-full`} type={key==='token'?'password':'text'} autoComplete="off" maxLength={key==='token'?4096:256} value={config[key]} onChange={e=>setConfig({...config,[key]:e.target.value})} /></label>)}
    <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={config.readConsent} onChange={e=>setConfig({...config,readConsent:e.target.checked})} />I authorize metadata reads to verify this destination, parent, Project field and counting.</label>
    <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={config.writeConsent} onChange={e=>setConfig({...config,writeConsent:e.target.checked})} />Allow issue, parent, dependency, Project membership and estimate writes after exact payload approval.</label>
    <button type="submit" disabled={busy||!config.readConsent} className={`${buttonPrimary} ${target}`}>Verify and store connection</button>
   </form>}
   {connection?.binding&&!settings&&env.endedAt===null&&<>
    <label className="block">Context parent<select className={`${inputClass} min-h-11 w-full`} value={parentId} disabled={busy} onChange={event=>{const id=event.target.value;setParentId(id);setSelected(env.state.stories.filter(s=>s.parentId===id&&s.planningRole==='planning'&&!s.removedAt).map(s=>s.id));invalidate();}}>{parents.map(p=><option key={p.id} value={p.id}>{p.title} · ID {p.id}</option>)}</select></label>
    <fieldset disabled={busy}><legend className="font-semibold">Children to publish</legend>
     {children.map(child=><label key={child.id} className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={selected.includes(child.id)} onChange={event=>{setSelected(event.target.checked?[...selected,child.id]:selected.filter(id=>id!==child.id));invalidate();}} />Publish {name(child.id)}</label>)}
    </fieldset>
    {pending.map(edge=><div key={edge.id}><p>{name(edge.dependentId)} is blocked by {name(edge.blockerId)}.</p><div className="flex flex-wrap gap-2"><button type="button" className={`${buttonQuiet} ${target}`} onClick={()=>{setSelected([...selected,edge.blockerId]);invalidate();}}>Include {name(edge.blockerId)}</button><span className="flex min-h-11 items-center">Leave dependency pending by keeping this selection.</span></div></div>)}
    <button type="button" disabled={busy||!parent||selected.length===0} className={`${buttonPrimary} ${target}`} onClick={()=>void perform(async()=>{setReview(await api<Review>("POST",root+"/preview",{parentId,children:selected}));setConsent(false);})}>Review publication for {parent?.title??'context parent'}</button>
   </>}
   {review&&<section aria-label="Actual reviewed payload" className="space-y-3">
    <h3 className="text-lg font-semibold">Actual payload and destination</h3>
    <dl><dt>Destination and type</dt><dd>{review.Binding.Destination} · {review.Binding.IssueType}</dd><dt>Native parent</dt><dd>Issue {review.Binding.ParentID}</dd><dt>Counting</dt><dd>Parent excluded by absence from Project membership. No rollup or parent estimate restore.</dd><dt>Project and field</dt><dd>{review.Binding.ProjectID} · NUMBER {review.Binding.FieldID}</dd><dt>Deck</dt><dd>{env.state.deck.name}: {env.state.deck.values.join(", ")}</dd><dt>Reviewed numeric mapping</dt><dd>{Object.entries(review.Binding.Mapping).map(([card,value])=>`${card} → ${value}`).join(', ')}. Blank remains unset; an unexpected default stays failed or verification-needed.</dd></dl>
    {review.Steps.map(step=><div key={step.key} className="border-t border-line pt-3">
     <p className="font-semibold">{step.kind} · {name(step.childId??step.dependentId)}</p>
     {step.kind==='create'&&<>{review.receipts?.find(r=>r.key===step.key)?.state==='confirmed'?<p>Existing issue {review.receipts.find(r=>r.key===step.key)?.remoteId} will be reused. Its title and refinement will not be rewritten.</p>:<p>New issue creation payload, or unresolved same identity:</p>}<p>Title: {step.title}</p><pre className="whitespace-pre-wrap font-sans">{step.body}</pre></>}
     {(step.kind==='dependency'||step.kind==='remove-dependency')&&<p>{name(step.dependentId)} is blocked by {name(step.blockerId)}{step.kind==='remove-dependency'?' — remove this link':''}{step.waiting?' — Waiting; dependency stays pending':''}</p>}
     {step.kind==='estimate'&&<p>Estimate: {step.value||'unset'}</p>}
    </div>)}
    <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)} />I approve this exact payload, destination, native links, numeric mapping and parent counting for these children.</label>
    <button type="button" disabled={busy||!consent||!connection?.writeConsent} className={`${buttonPrimary} ${target}`} onClick={()=>void publish()}>Approve and publish {parent?.title}</button>
   </section>}
   {previous.length>0&&<section aria-label="Saved publication reviews"><h3 className="font-semibold">Saved reviews</h3>{previous.map(saved=><button key={saved.id} type="button" className={`${buttonQuiet} ${target} my-1 block`} disabled={busy} onClick={()=>void perform(async()=>{setReviewId(saved.id);setReview(null);setConsent(false);await loadReceipts(saved.id);})}>View saved receipts for {name(saved.parentId)} · Review {saved.id}</button>)}</section>}
   {reviewId&&<section aria-label="Publication receipts" className="space-y-3">
    <h3 className="text-lg font-semibold">Separate delivery receipts</h3>
    <p>Confirmed records a historical readback of that step. It does not verify current upstream access, completion or automatic unblocking.</p>
    {receipts.map(receipt=><div key={receipt.key} className="border-t border-line pt-3"><p>{receipt.kind} · {name(receipt.childId??receipt.dependentId)}</p><p>{stateText[receipt.state]??'Unavailable — review access'}{receipt.state==='confirmed'&&receipt.remoteId?` — issue ${receipt.remoteId}`:''}</p></div>)}
    <button type="button" disabled={busy} className={`${buttonQuiet} ${target}`} onClick={()=>void perform(async()=>{try{await api("POST",`${root}/reviews/${reviewId}/verify`,{});}finally{await loadReceipts(reviewId);}setNotice("Unknown receipts checked against current GitHub access. No writes were authorized.");})}>Refresh unknown receipts</button>
    <p>To retry failed or pending steps, review the current split again. The same issued identities are retained. If a link needs cleanup, change the local graph, review the explicit removal, then publish.</p>
   </section>}
   {error&&<p role="alert">{error}</p>}
   <p role="status" aria-live="polite">{busy?'Checking publication…':notice}</p>
   <button type="button" className={`${buttonQuiet} ${target}`} onClick={onClose}>Close publication review</button>
  </div>
 </Modal>;
}
