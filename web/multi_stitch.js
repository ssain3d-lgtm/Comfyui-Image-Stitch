import { app } from "../../scripts/app.js";
import { openCropEditor } from "./crop_editor.js";
import { getWidget, hideWidget, isCropped, loadThumb, normalizeCrop, safeJsonParse, syncImages, uploadFile } from "./shared.js";

const NODE_TYPE = "MultiStitchImages";
const THUMB_HEIGHT = 92, THUMB_GAP = 7, THUMB_COLS = 3, MIN_NODE_WIDTH = 390;

function visibleWidgetBottom(node) {
    let bottom = 92;
    for (const widget of node.widgets || []) {
        if (widget._msHidden) continue;
        if (Number.isFinite(widget.last_y)) bottom = Math.max(bottom, widget.last_y + 28);
    }
    return bottom;
}

function thumbLayout(node, index) {
    const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || MIN_NODE_WIDTH);
    const top = visibleWidgetBottom(node) + 26;
    const cellW = (width - 16 - THUMB_GAP * (THUMB_COLS - 1)) / THUMB_COLS;
    const col = index % THUMB_COLS, row = Math.floor(index / THUMB_COLS);
    return { x: 8 + col * (cellW + THUMB_GAP), y: top + row * (THUMB_HEIGHT + THUMB_GAP), w: cellW, h: THUMB_HEIGHT };
}

function updateNodeSize(node) {
    const rows = Math.max(1, Math.ceil((node._msImages?.length || 0) / THUMB_COLS));
    const wantedH = visibleWidgetBottom(node) + 26 + rows * THUMB_HEIGHT + (rows - 1) * THUMB_GAP + 12;
    const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || 0);
    if (!node.size || node.size[0] < MIN_NODE_WIDTH || node.size[1] < wantedH) node.setSize?.([width, Math.max(wantedH, node.size?.[1] || 0)]);
}

function drawContained(ctx, image, crop, rect) {
    const c = normalizeCrop(crop), sx=c.x*image.naturalWidth, sy=c.y*image.naturalHeight, sw=c.w*image.naturalWidth, sh=c.h*image.naturalHeight;
    const scale=Math.min(rect.w/sw,rect.h/sh), dw=sw*scale, dh=sh*scale;
    ctx.drawImage(image,sx,sy,sw,sh,rect.x+(rect.w-dw)/2,rect.y+(rect.h-dh)/2,dw,dh);
}

function predictedSize(node) {
    const items=node._msImages||[]; if(!items.length)return null;
    const dims=[];
    for(const item of items){const state=loadThumb(node,item);if(!state.ready)return null;const c=normalizeCrop(item.crop);dims.push({w:Math.max(1,Math.round(state.image.naturalWidth*c.w)),h:Math.max(1,Math.round(state.image.naturalHeight*c.h))});}
    const direction=getWidget(node,"direction")?.value||"right", match=!!getWidget(node,"match_image_size")?.value, spacing=Math.max(0,Number(getWidget(node,"spacing_width")?.value)||0);
    if(match&&dims.length>1){const first=dims[0];for(let i=1;i<dims.length;i++){const d=dims[i];if(direction==="left"||direction==="right"){d.w=Math.max(1,Math.round(d.w*first.h/d.h));d.h=first.h;}else{d.h=Math.max(1,Math.round(d.h*first.w/d.w));d.w=first.w;}}}
    return direction==="left"||direction==="right"?{w:dims.reduce((s,d)=>s+d.w,0)+spacing*(dims.length-1),h:Math.max(...dims.map(d=>d.h))}:{w:Math.max(...dims.map(d=>d.w)),h:dims.reduce((s,d)=>s+d.h,0)+spacing*(dims.length-1)};
}

function drawThumbs(node, ctx) {
    if(node.flags?.collapsed)return;
    const items=node._msImages||[], count=items.length, top=visibleWidgetBottom(node)+8;
    ctx.save();ctx.font="12px sans-serif";ctx.fillStyle="#b8b8b8";
    const predicted=predictedSize(node);ctx.fillText(count?`${count} image${count===1?"":"s"}${predicted?`  •  ~${predicted.w}×${predicted.h}`:""}  •  click image to crop`:"Select this node, then Ctrl+V images",9,top+12);
    if(!count){const r=thumbLayout(node,0);ctx.strokeStyle="#666";ctx.setLineDash([5,5]);ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.setLineDash([]);ctx.fillStyle="#8f8f8f";ctx.textAlign="center";ctx.fillText("Paste / Drop / Add images",r.x+r.w/2,r.y+r.h/2+4);ctx.restore();return;}
    items.forEach((item,index)=>{
        const r=thumbLayout(node,index);ctx.fillStyle="#171717";ctx.fillRect(r.x,r.y,r.w,r.h);ctx.strokeStyle=isCropped(item.crop)?"#f6b73c":"#555";ctx.strokeRect(r.x+.5,r.y+.5,r.w-1,r.h-1);
        const state=loadThumb(node,item), imageRect={x:r.x+3,y:r.y+3,w:r.w-6,h:r.h-6};
        if(state.ready){ctx.save();ctx.beginPath();ctx.rect(imageRect.x,imageRect.y,imageRect.w,imageRect.h);ctx.clip();drawContained(ctx,state.image,item.crop,imageRect);ctx.restore();}else{ctx.fillStyle="#8d8d8d";ctx.textAlign="center";ctx.fillText(state.failed?"Load failed":"Loading…",r.x+r.w/2,r.y+r.h/2+4);}
        ctx.textAlign="left";ctx.fillStyle="rgba(0,0,0,.72)";ctx.fillRect(r.x+3,r.y+3,27,19);ctx.fillStyle="#fff";ctx.fillText(String(index+1),r.x+11,r.y+17);
        if(isCropped(item.crop)){ctx.fillStyle="rgba(0,0,0,.72)";ctx.fillRect(r.x+33,r.y+3,25,19);ctx.fillStyle="#f6b73c";ctx.fillText("✂",r.x+39,r.y+17);}
        ctx.fillStyle="rgba(0,0,0,.72)";ctx.fillRect(r.x+r.w-23,r.y+3,20,19);ctx.fillRect(r.x+3,r.y+r.h-22,20,19);ctx.fillRect(r.x+r.w-23,r.y+r.h-22,20,19);ctx.fillStyle="#fff";ctx.fillText("×",r.x+r.w-18,r.y+17);ctx.fillText("‹",r.x+9,r.y+r.h-7);ctx.fillText("›",r.x+r.w-17,r.y+r.h-7);
    });ctx.restore();
}

function localPos(node,event,pos,graphCanvas){if(event&&typeof event.canvasX==="number")return[event.canvasX-node.pos[0],event.canvasY-node.pos[1]];try{if(graphCanvas?.convertEventToCanvasOffset){const p=graphCanvas.convertEventToCanvasOffset(event);return[p[0]-node.pos[0],p[1]-node.pos[1]];}}catch(_){}return Array.isArray(pos)?pos:[0,0];}
const inRect=(x,y,r)=>x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h;
function stopEvent(event,graphCanvas){if(graphCanvas)graphCanvas._mouse_down_widget=true;try{event?.preventDefault?.();event?.stopPropagation?.();}catch(_){}}

function changed(node){syncImages(node);updateNodeSize(node);}
function moveItem(node,index,delta){const target=index+delta;if(target<0||target>=node._msImages.length)return;const[item]=node._msImages.splice(index,1);node._msImages.splice(target,0,item);changed(node);}

async function addFiles(node, files) {
    const images=Array.from(files||[]).filter(file=>file&&file.type?.startsWith("image/"));if(!images.length||node._msUploading)return;
    node._msUploading=true;const originalTitle=node.title;node.title="Multi Stitch Images • uploading…";node.graph?.setDirtyCanvas(true,true);
    try{for(const file of images){node._msImages.push(await uploadFile(file));changed(node);}}
    catch(error){console.error("[Multi Stitch Images]",error);alert(`Multi Stitch Images\n${error?.message||error}`);}
    finally{node._msUploading=false;node.title=originalTitle||"Multi Stitch Images";node.graph?.setDirtyCanvas(true,true);}
}

function chooseFiles(node){const input=document.createElement("input");input.type="file";input.accept="image/*";input.multiple=true;input.style.display="none";document.body.appendChild(input);input.addEventListener("change",async()=>{await addFiles(node,input.files);input.remove();},{once:true});input.click();}

function setupNode(node){
    node.previewMediaType="image";node.properties||={};
    const widget=getWidget(node,"images_json");hideWidget(widget);const fromWidget=safeJsonParse(widget?.value),fromProps=safeJsonParse(node.properties.multi_stitch_images);
    node._msImages=(fromWidget.length?fromWidget:fromProps).map(item=>({...item,crop:normalizeCrop(item.crop)}));node._msThumbCache=new Map();
    if(!node.widgets?.some(w=>w.name==="add_images")){node.addWidget("button","add_images","Add images…",()=>chooseFiles(node));node.addWidget("button","clear_images","Clear all",()=>{if(!node._msImages.length||confirm(`Remove all ${node._msImages.length} images from this node?`)){node._msImages=[];node._msThumbCache.clear();changed(node);}});}
    node.pasteFiles=(files)=>addFiles(node,files);changed(node);
}

app.registerExtension({
    name:"ssain3d.MultiStitchImages",
    async beforeRegisterNodeDef(nodeType,nodeData){
        if(nodeData.name!==NODE_TYPE)return;
        const created=nodeType.prototype.onNodeCreated;nodeType.prototype.onNodeCreated=function(){const r=created?.apply(this,arguments);setupNode(this);return r;};
        const configured=nodeType.prototype.onConfigure;nodeType.prototype.onConfigure=function(info){const r=configured?.apply(this,arguments),widget=getWidget(this,"images_json"),restored=safeJsonParse(widget?.value),props=safeJsonParse(info?.properties?.multi_stitch_images||this.properties?.multi_stitch_images);this._msImages=(restored.length?restored:props).map(item=>({...item,crop:normalizeCrop(item.crop)}));hideWidget(widget);changed(this);return r;};
        const serialize=nodeType.prototype.onSerialize;nodeType.prototype.onSerialize=function(data){serialize?.apply(this,arguments);const serialized=JSON.stringify(this._msImages||[]);data.properties||={};data.properties.multi_stitch_images=serialized;const widget=getWidget(this,"images_json");if(widget)widget.value=serialized;};
        const draw=nodeType.prototype.onDrawForeground;nodeType.prototype.onDrawForeground=function(ctx){draw?.apply(this,arguments);drawThumbs(this,ctx);};
        const mouse=nodeType.prototype.onMouseDown;nodeType.prototype.onMouseDown=function(event,pos,graphCanvas){if(!this.flags?.collapsed&&this._msImages?.length){const[x,y]=localPos(this,event,pos,graphCanvas);for(let i=0;i<this._msImages.length;i++){const r=thumbLayout(this,i);if(!inRect(x,y,r))continue;const remove={x:r.x+r.w-23,y:r.y+3,w:20,h:19},prev={x:r.x+3,y:r.y+r.h-22,w:20,h:19},next={x:r.x+r.w-23,y:r.y+r.h-22,w:20,h:19};if(inRect(x,y,remove)){this._msImages.splice(i,1);changed(this);}else if(inRect(x,y,prev))moveItem(this,i,-1);else if(inRect(x,y,next))moveItem(this,i,1);else openCropEditor(this,i).catch(error=>{console.error("[Multi Stitch Images] crop editor",error);alert(error.message||error);});stopEvent(event,graphCanvas);return true;}}return mouse?.apply(this,arguments)??false;};
        const dragOver=nodeType.prototype.onDragOver;nodeType.prototype.onDragOver=function(event){if(Array.from(event?.dataTransfer?.items||[]).some(item=>item.type?.startsWith("image/")))return true;return dragOver?.apply(this,arguments)??false;};
        const dragDrop=nodeType.prototype.onDragDrop;nodeType.prototype.onDragDrop=function(event){const files=Array.from(event?.dataTransfer?.files||[]).filter(file=>file.type?.startsWith("image/"));if(files.length){addFiles(this,files);event.preventDefault?.();return true;}return dragDrop?.apply(this,arguments)??false;};
    }
});
