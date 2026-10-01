import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const workspaceDir = "/home/levi/JupyterExtension";
const SKILL_DIR = "/home/levi/.codex/plugins/cache/openai-primary-runtime/presentations/26.930.11008/skills/presentations";
const TMP_DIR = path.join(workspaceDir, ".codex-build-methodology");
const FINAL_PPTX = path.join(workspaceDir, "output", "LinkMaker_Research_Methodology_Proposal.pptx");
const RUNTIME_PYTHON = "/home/levi/miniconda3/envs/linkmaker/bin/python";
const { resolvePresentationFont, finalizePresentation } = await import(
  pathToFileURL(path.join(SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href
);

await fs.mkdir(TMP_DIR, { recursive: true });
await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });
const family = resolvePresentationFont();
const p = Presentation.create({ slideSize: { width: 1280, height: 720 } });

const C = {
  ink: "#172A3A", muted: "#5B6B79", teal: "#159A91", tealDark: "#08756F",
  mint: "#E7F5F3", orange: "#F28E5B", amber: "#FFF1E8", blue: "#3B82C4",
  bluePale: "#EAF3FB", white: "#FFFFFF", line: "#D7E2E7", bg: "#F7FAFB",
  red: "#C84C4C", green: "#2A8F62"
};

function rect(slide, x, y, w, h, fill, radius = true, line = "none") {
  return slide.shapes.add({ geometry: radius ? "roundRect" : "rect", position: { left:x, top:y, width:w, height:h }, fill, line: line === "none" ? { fill:"none", width:0 } : { fill:line, width:1 } });
}
function txt(slide, text, x, y, w, h, size=22, color=C.ink, bold=false, align="left") {
  const s = slide.shapes.add({ geometry:"textbox", position:{left:x,top:y,width:w,height:h}, fill:"none", line:{fill:"none",width:0} });
  s.text = text;
  s.text.style = { typeface:family, fontSize:size, color, bold, alignment:align, verticalAlignment:"middle", autoFit:"shrinkText" };
  return s;
}
function line(slide, x1, y1, x2, y2, color=C.line, width=2) {
  return slide.shapes.add({ geometry:"line", position:{left:x1,top:y1,width:x2-x1,height:y2-y1}, fill:"none", line:{fill:color,width} });
}
function base(title, kicker, n) {
  const s = p.slides.add(); s.background.fill = C.bg;
  rect(s, 0, 0, 14, 720, C.teal, false);
  txt(s, kicker.toUpperCase(), 50, 31, 680, 24, 14, C.tealDark, true);
  txt(s, title, 50, 59, 1160, 62, 34, C.ink, true);
  line(s, 50, 133, 1210, 133, C.line, 1);
  txt(s, String(n), 1190, 678, 40, 20, 12, C.muted, false, "right");
  return s;
}
function card(s, x,y,w,h, title, body, accent=C.teal, bodySize=18) {
  rect(s,x,y,w,h,C.white,true,C.line); rect(s,x,y,7,h,accent,true);
  txt(s,title,x+23,y+18,w-40,31,20,C.ink,true);
  txt(s,body,x+23,y+57,w-42,h-72,bodySize,C.muted,false);
}
function pill(s, text, x,y,w, fill=C.mint, color=C.tealDark) {
  rect(s,x,y,w,30,fill,true); txt(s,text,x+9,y+3,w-18,23,13,color,true,"center");
}
function notes(s, body) { s.speakerNotes.textFrame.setText(body); }

// 1 — Cover
{
  const s=p.slides.add(); s.background.fill=C.ink;
  rect(s,0,0,18,720,C.teal,false);
  pill(s,"RESEARCH PROPOSAL",65,58,176,C.teal,C.white);
  txt(s,"From automatic links\nto explainable notebook navigation",65,135,1040,160,43,C.white,true);
  txt(s,"Functional differentiation · formative study · technical evaluation · user study",68,327,980,54,22,"#C9D7DE");
  rect(s,68,446,1080,2,C.teal,false);
  txt(s,"LinkMaker",68,477,450,42,25,C.white,true);
  txt(s,"Methodology proposal",68,522,450,34,18,"#C9D7DE");
  txt(s,"October 2026",1010,650,140,24,14,"#C9D7DE",false,"right");
  notes(s,"Purpose: convert the professor's feedback into a defensible research plan. The proposed contribution remains a hypothesis until the formative study validates the target users and tasks.");
}

// 2
{
  const s=base("What the literature supports — and what it does not", "Interpretation check", 2);
  card(s,55,165,365,225,"Supported","Formative evidence can reveal pain points and turn them into design requirements. InterLink used interviews; Themisto used an in-depth analysis of 80 notebooks.",C.green,17);
  card(s,457,165,365,225,"Supported","Overview, zoom, filter, details-on-demand, relate, history and extract are established information-seeking tasks.",C.blue,17);
  card(s,859,165,365,225,"Needs validation","History is not automatically a contribution. The novelty must be the specific history behavior, target task and measured benefit.",C.orange,17);
  rect(s,55,430,1169,160,C.mint,true); txt(s,"Correction",79,451,180,30,18,C.tealDark,true);
  txt(s,"Your reasoning is aligned. Reframe “history” as a testable design hypothesis: a semantic trail of visited relationships that helps readers resume, revisit and compare evidence across code, Markdown and outputs.",79,489,1090,75,23,C.ink,true);
  notes(s,"Sources: https://arxiv.org/abs/2502.16114 ; https://arxiv.org/abs/2102.12592 ; https://hci.stanford.edu/courses/cs448b/papers/shneiderman96eyes.pdf");
}

// 3
{
  const s=base("The defensible gap relative to InterLink", "Research gap", 3);
  txt(s,"INTERLINK",62,163,265,28,16,C.muted,true); txt(s,"LINKMAKER OPPORTUNITY",696,163,450,28,16,C.tealDark,true);
  const rows=[
    ["Presents pre-specified relationships","Infers candidate relationships automatically"],
    ["Optimizes layout and navigation","Shows exact evidence, reason and provenance"],
    ["Uses manually reviewed link sets in evaluation","Measures link quality against expert annotations"],
    ["Two-column reading interface","Tests code-first progressive disclosure and semantic history"]
  ];
  rows.forEach((r,i)=>{const y=205+i*98; rect(s,55,y,515,73,C.white,true,C.line); rect(s,650,y,574,73,i===0?C.mint:C.white,true,C.line); txt(s,r[0],77,y+15,470,43,18,C.ink,i===0); txt(s,r[1],674,y+15,525,43,18,C.ink,true); txt(s,"→",588,y+18,42,37,25,C.orange,true,"center");});
  txt(s,"Primary contribution candidate",55,618,275,25,15,C.tealDark,true);
  txt(s,"Automatic, inspectable relationship creation + navigation designed around evidence verification.",334,610,890,42,22,C.ink,true);
  notes(s,"InterLink states that relationship specification is future work and studies the presentation of specified links. For its evaluation, two formative-study participants annotated relationships and reviewed/refined them with the authors. Source: https://arxiv.org/html/2502.16114");
}

// 4
{
  const s=base("A three-part functional contribution", "Proposed differential", 4);
  const xs=[55,445,835];
  const items=[
    ["1","Automatic inference","Create multi-granular Markdown–code–output candidates; use output text and generating code as evidence."],
    ["2","Inspectable evidence","Expose exact spans, localized chart/table regions, confidence and a human-readable reason."],
    ["3","Semantic navigation","Code-first overview, on-demand related text, focus mode and a trail for resuming prior relationship visits."]
  ];
  items.forEach((it,i)=>{rect(s,xs[i],180,350,350,C.white,true,C.line); rect(s,xs[i]+24,207,54,54,i===2?C.orange:C.teal,true); txt(s,it[0],xs[i]+24,215,54,38,22,C.white,true,"center"); txt(s,it[1],xs[i]+24,282,300,54,23,C.ink,true); txt(s,it[2],xs[i]+24,352,300,128,18,C.muted,false);});
  rect(s,55,563,1130,67,C.amber,true); txt(s,"Research claim",78,577,170,30,16,C.orange,true); txt(s,"The value is not “more links”; it is faster and more accurate verification of why notebook elements belong together.",251,570,900,43,21,C.ink,true);
  notes(s,"The three parts should not be claimed as validated contributions yet. The formative study and staged evaluations establish which parts solve real tasks and which should be removed or revised.");
}

// 5
{
  const s=base("Formative study: turn assumptions into requirements", "Phase 1", 5);
  const phases=[
    ["Recruit","6–10 practicing data scientists\nwith shared-notebook experience"],
    ["Observe","Walk through a recent unfamiliar notebook; think aloud and identify breakdowns"],
    ["Probe","Critical incidents: finding evidence, revisiting results, checking outputs, trusting links"],
    ["Synthesize","Thematic analysis → pain points → tasks → design requirements"]
  ];
  phases.forEach((a,i)=>{const x=54+i*298; rect(s,x,190,260,255,C.white,true,C.line); pill(s,String(i+1),x+20,211,42,i===3?C.amber:C.mint,i===3?C.orange:C.tealDark); txt(s,a[0],x+20,262,216,37,21,C.ink,true); txt(s,a[1],x+20,315,216,100,17,C.muted); if(i<3) txt(s,"→",x+267,292,27,38,24,C.orange,true,"center");});
  rect(s,54,487,1154,122,C.bluePale,true); txt(s,"Decision gates",78,505,176,28,17,C.blue,true);
  txt(s,"Do users start from code?  •  Do they lose context across distant cells?  •  Does a visit history support real resumption tasks?  •  What evidence makes an automatic link trustworthy?",78,541,1087,48,20,C.ink,true);
  notes(s,"InterLink used semi-structured interviews with six experienced shared-notebook users. Participants inspected a notebook for up to 20 minutes and discussed challenges and desired features. This proposal adds critical-incident and resumption probes targeted to LinkMaker. Source: https://arxiv.org/html/2502.16114");
}

// 6
{
  const s=base("Research questions and falsifiable hypotheses", "Study logic", 6);
  const qs=[
    ["RQ1 · Link quality","Does output-aware context improve the correctness and coverage of inferred relationships?","H1: output text + generating code increases relation F1 over code-only context."],
    ["RQ2 · Comprehension","Do inspectable links improve notebook understanding?","H2: LinkMaker improves accuracy and inverse efficiency over standard Jupyter."],
    ["RQ3 · Resumption","Does semantic history help readers return to prior evidence?","H3: history reduces revisit time, scrolling and navigation steps."],
    ["RQ4 · Trust","Do reasons and exact evidence help users verify suggestions?","H4: explanations improve calibrated acceptance and error detection."]
  ];
  qs.forEach((q,i)=>{const y=165+i*116; rect(s,55,y,1129,94,C.white,true,C.line); pill(s,q[0],73,y+17,220,i===0?C.mint:C.bluePale,i===0?C.tealDark:C.blue); txt(s,q[1],314,y+12,827,30,18,C.ink,true); txt(s,q[2],314,y+48,827,29,16,C.muted,false);});
  notes(s,"These hypotheses map each proposed function to a measurable outcome. Results may reject any feature; that is preferable to positioning an unvalidated feature as the contribution.");
}

// 7
{
  const s=base("Technical evaluation of automatic relationships", "Phase 2A", 7);
  card(s,55,168,344,193,"Ground truth","Two or more annotators label cell pairs, exact spans and output regions. Resolve disagreements and report agreement.",C.teal,17);
  card(s,427,168,344,193,"Ablations","Code only vs + output text; chart/output alone vs + generating code; full context vs retrieved candidates.",C.blue,17);
  card(s,799,168,425,193,"Metrics","Cell-link precision, recall and F1; span overlap/IoU; output-region IoU; token cost, latency and failure rate.",C.orange,17);
  txt(s,"Minimum comparison matrix",55,402,360,30,18,C.ink,true);
  const labels=["Code only","+ output text","+ generating code","+ retrieval / reduced context"];
  labels.forEach((v,i)=>{const y=447+i*43; rect(s,55,y,520,33,i===3?C.mint:C.white,true,C.line); txt(s,v,72,y+3,480,25,15,C.ink,i===3);});
  rect(s,615,447,609,162,C.ink,true); txt(s,"Success criterion",640,466,250,26,16,C.teal,true);
  txt(s,"Report improvement with confidence intervals and error categories—not only a single model run or anecdotal examples.",640,506,540,71,21,C.white,true);
  notes(s,"InterLink's evaluation relationships were manually annotated and refined, which provides a useful precedent for ground-truth creation. LinkMaker must additionally evaluate automatic inference. Source: https://arxiv.org/html/2502.16114");
}

// 8
{
  const s=base("Controlled user study for the interface", "Phase 2B", 8);
  card(s,55,166,359,201,"Design","Within-subject, counterbalanced study. Primary baseline: standard Jupyter. Secondary ablation: LinkMaker without semantic history.",C.teal,17);
  card(s,449,166,359,201,"Tasks","Find a fact; explain code behavior; integrate Markdown, code and output; verify a suggested link; resume after interruption.",C.blue,17);
  card(s,843,166,381,201,"Participants","Target practicing data scientists. Use notebooks and domains matched for difficulty; pilot the task set first.",C.orange,17);
  txt(s,"Quantitative",55,410,205,28,18,C.ink,true); txt(s,"Qualitative",656,410,205,28,18,C.ink,true);
  const q1=["Answer accuracy","Completion time + IES","Confidence calibration","Navigation steps / scroll distance","Revisit time and history use"];
  const q2=["Think-aloud observations","Post-condition questionnaire","SUS or UMUX-Lite","Workload measure","Semi-structured interview + thematic analysis"];
  q1.forEach((v,i)=>{pill(s,"✓",55,452+i*35,31,C.mint,C.tealDark);txt(s,v,95,452+i*35,500,27,16,C.muted,i===0);});
  q2.forEach((v,i)=>{pill(s,"✓",656,452+i*35,31,C.bluePale,C.blue);txt(s,v,696,452+i*35,500,27,16,C.muted,i===0);});
  notes(s,"InterLink used a within-subject design with 12 participants, two notebooks, counterbalancing, task accuracy, confidence, completion time, inverse efficiency, SUS/Likert ratings and qualitative feedback. It reported a 13.6% accuracy improvement. Source: https://arxiv.org/abs/2502.16114");
}

// 9
{
  const s=base("Recommended research sequence", "Execution plan", 9);
  const stages=[
    ["01","Formative study","Validate users, tasks and pain points","GO: stable requirements"],
    ["02","Annotation protocol","Create expert ground truth and agreement rules","GO: reliable benchmark"],
    ["03","Technical ablations","Test output context, generating code and retrieval","GO: measurable link quality"],
    ["04","UI pilot","Repair tasks, timing and interaction issues","GO: study-ready prototype"],
    ["05","Controlled study","Compare comprehension, navigation and resumption","GO: defensible contribution"]
  ];
  stages.forEach((a,i)=>{const x=54+i*236; rect(s,x,175,210,354,C.white,true,C.line); txt(s,a[0],x+20,195,60,35,22,i===4?C.orange:C.teal,true); txt(s,a[1],x+20,252,170,57,20,C.ink,true); txt(s,a[2],x+20,326,170,87,16,C.muted); rect(s,x+15,445,180,54,i===4?C.amber:C.mint,true); txt(s,a[3],x+25,453,160,38,14,i===4?C.orange:C.tealDark,true,"center"); if(i<4) txt(s,"→",x+208,337,28,34,23,C.orange,true,"center");});
  rect(s,54,566,1154,73,C.ink,true); txt(s,"Recommended thesis position",78,579,248,26,16,C.teal,true); txt(s,"LinkMaker supports evidence-aware comprehension by automatically creating, explaining and revisiting relationships in computational notebooks.",326,573,844,43,20,C.white,true);
  notes(s,"Recommended next artifacts: interview guide, consent/recruitment plan, annotation handbook, frozen notebook benchmark, analysis plan and pilot protocol. Related sources: InterLink https://arxiv.org/abs/2502.16114 ; Themisto https://arxiv.org/abs/2102.12592 ; Voder https://www.microsoft.com/en-us/research/publication/augmenting-visualizations-with-interactive-data-facts-to-facilitate-interpretation-and-communication/ ; Shneiderman https://hci.stanford.edu/courses/cs448b/papers/shneiderman96eyes.pdf");
}

const stagingDir = path.join(workspaceDir, ".codex-finalizer-methodology");
await fs.mkdir(stagingDir, { recursive:true });
const candidatePath = path.join(stagingDir, "candidate.pptx");
await (await PresentationFile.exportPptx(p)).save(candidatePath);
for (let i=0;i<p.slides.items.length;i++) {
  const slide=p.slides.items[i];
  const preview=await p.export({slide,format:"png",scale:1});
  await fs.writeFile(path.join(TMP_DIR,`slide-${i+1}.png`),new Uint8Array(await preview.arrayBuffer()));
}
const requirements={ explicitTotalSlideCount:9, requiredNativeTableOwnerSlides:[], requiredNativeChartOwnerSlides:[] };
const fontPolicy={ basis:"design", families:[family] };
await finalizePresentation({
  ...requirements, workspaceDir, candidatePath, finalPath:FINAL_PPTX,
  pythonExecutable:RUNTIME_PYTHON,
  integrityValidatorPath:path.join(SKILL_DIR,"container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath:path.join(SKILL_DIR,"container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs:["--expected-slide-size-emu","12192000,6858000","--validate-bullet-geometry","--validate-heading-fit"],
  requiredNativeTableOwnerSlides:[], fontPolicy, verifyArtifactToolImport:true,
  receiptPath:path.join(stagingDir,`${path.basename(FINAL_PPTX)}.validation.json`)
});
console.log(FINAL_PPTX);
