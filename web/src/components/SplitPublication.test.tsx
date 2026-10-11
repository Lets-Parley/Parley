import { afterEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../test/render";
import { expectNoViolations } from "../test/axe";
import { ApiError, api, type Envelope, type Story } from "../lib/api";
import { SplitPublication } from "./SplitPublication";
vi.mock("../lib/api", async original => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
const parent = {id:"parent",title:"Project",planningRole:"context",contentRevision:1} as Story;
const children = ["API","UI"].map(id => ({id,title:id,parentId:"parent",planningRole:"planning",contentRevision:1,estimate:id==="API"?"3":null}) as Story);
const env = {id:"room",endedAt:null,state:{stories:[parent,...children],dependencies:[{id:"edge",parentId:"parent",blockerId:"API",dependentId:"UI",retiredAt:null}],deck:{values:["1","2","3","5"]}}} as unknown as Envelope;
const binding = {Destination:"github:test/repo",IssueType:"ordinary",ParentID:"10",ParentDisposition:"excluded-from-counting",ProjectID:"project",FieldID:"field",Mapping:{"3":"3"}};
const review = {ID:"",Fingerprint:"fingerprint",Binding:binding,Steps:[{key:"key",kind:"create",childId:"UI",title:"UI",body:"Reviewed refinement\n\n<!-- parley-publication:key -->",binding},{key:"edge",kind:"dependency",blockerId:"API",dependentId:"UI",waiting:true,binding},{key:"estimate",kind:"estimate",childId:"UI",value:"",binding}]};
afterEach(()=>vi.resetAllMocks());
function mocked() {
 vi.mocked(api).mockImplementation(async (method,path)=> {
  if (path.endsWith("/connection"))return {available:true,binding,writeConsent:true};
  if(path.endsWith("/preview"))return review;
  if(path.endsWith("/approve"))return {...review,ID:"approved"};
  if(path.endsWith("/receipts"))return [{key:"key",kind:"create",childId:"UI",state:"confirmed",remoteId:"11",attempts:1},{key:"estimate",kind:"estimate",childId:"UI",state:"unknown",attempts:1}];
  if(method==="GET"&&path.endsWith("/reviews"))return [];
  return {};
 });
}
it("shows actual payload and pending blockers, requires explicit consent, and separates receipts",async()=>{
 mocked();const user=userEvent.setup();const {container}=renderApp(<SplitPublication env={env} />);
 await user.click(screen.getByRole("button",{name:"Publish splits to GitHub"}));
 await user.click(await screen.findByRole("checkbox",{name:"Publish API · ID API"}));
 await user.click(screen.getByRole("button",{name:"Review publication for Project"}));
 expect(await screen.findByText(/Reviewed refinement/)).toBeTruthy();
 expect(screen.getAllByText(/UI.*is blocked by API/).length).toBeGreaterThan(0);
 expect(screen.getByText(/Blank remains unset/)).toBeTruthy();
 expect((screen.getByRole("button",{name:"Approve and publish Project"}) as HTMLButtonElement).disabled).toBe(true);
 await user.click(screen.getByRole("checkbox",{name:/I approve this exact payload/}));
 await user.click(screen.getByRole("button",{name:"Approve and publish Project"}));
 expect(await screen.findByText("Confirmed — issue 11")).toBeTruthy();
 expect(screen.getByText(/Unknown — refresh receipts/)).toBeTruthy();
 const sent=vi.mocked(api).mock.calls.find(call=>call[1].endsWith("/approve"));
 expect(sent?.[2]).toEqual({parentId:"parent",children:["UI"],fingerprint:"fingerprint",writeConsent:true});
 await expectNoViolations(container);
});
it("invalidates payload consent after content change and restores opener focus on close",async()=>{
 mocked();const user=userEvent.setup();const {rerender}=renderApp(<SplitPublication env={env} />);
 const opener=screen.getByRole("button",{name:"Publish splits to GitHub"});await user.click(opener);
 await user.click(await screen.findByRole("button",{name:"Review publication for Project"}));
 await screen.findByText(/Reviewed refinement/);
 await user.click(screen.getByRole("checkbox",{name:/I approve this exact payload/}));
 rerender(<SplitPublication env={{...env,state:{...env.state,stories:[parent,{...children[0],title:"Changed",contentRevision:2},children[1]]}}} />);
 await waitFor(()=>expect(screen.queryByRole("checkbox",{name:/I approve this exact payload/})).toBeNull());
 expect(screen.getByText(/Split changed; review the latest payload/)).toBeTruthy();
 await user.click(screen.getByRole("button",{name:"Close publication review"}));
 await waitFor(()=>expect(document.activeElement).toBe(opener));
});

it.each([401,403,404])("clears payload, receipts and connection after local access denial %i",async status=>{
 mocked();const user=userEvent.setup();renderApp(<SplitPublication env={env} />);
 await user.click(screen.getByRole("button",{name:"Publish splits to GitHub"}));
 await user.click(await screen.findByRole("button",{name:"Review publication for Project"}));
 await screen.findByText(/Reviewed refinement/);
 await user.click(screen.getByRole("checkbox",{name:/I approve this exact payload/}));
 await user.click(screen.getByRole("button",{name:"Approve and publish Project"}));
 await screen.findByText("Confirmed — issue 11");
 const original=vi.mocked(api).getMockImplementation()!;
 vi.mocked(api).mockImplementation(async(method,path,...rest)=>{if(path.endsWith("/preview"))throw new ApiError(status,"access is unavailable");return original(method,path,...rest)});
 await user.click(screen.getByRole("button",{name:"Review publication for Project"}));
 await screen.findByRole("alert");
 expect(screen.queryByRole("region",{name:"Actual reviewed payload"})).toBeNull();
 expect(screen.queryByRole("region",{name:"Publication receipts"})).toBeNull();
 expect(screen.queryByText(/Stored connection:/)).toBeNull();
 expect(screen.queryByRole("button",{name:"Review publication for Project"})).toBeNull();
});
it("shows reused steps as historical and omits unsent creation text",async()=>{
 mocked();const original=vi.mocked(api).getMockImplementation()!;
 vi.mocked(api).mockImplementation(async(method,path,...rest)=>path.endsWith("/preview")?{...review,receipts:review.Steps.map(step=>({...step,state:"confirmed",remoteId:step.kind==="create"?"11":"",attempts:1}))}:original(method,path,...rest));
 const user=userEvent.setup();renderApp(<SplitPublication env={env} />);
 await user.click(screen.getByRole("button",{name:"Publish splits to GitHub"}));
 await user.click(await screen.findByRole("button",{name:"Review publication for Project"}));
 await screen.findByText(/Existing issue 11 will be reused/);
 expect(screen.queryByText(/Reviewed refinement/)).toBeNull();
 expect(screen.queryByText("Title: UI")).toBeNull();
 expect(screen.getAllByText(/Already confirmed; no write is planned/)).toHaveLength(review.Steps.length);
 expect(screen.getByText(/Blank remains unset/)).toBeTruthy();
});
