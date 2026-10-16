import{c as v,_ as m}from"./index-Doo4QFjq.js";import{r as u}from"./vendor-67H7mWu9.js";/**
 * @license lucide-react v0.525.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]],p=v("check",f);function b(n,o=2e4){const c=u.useRef(n);c.current=n,u.useEffect(()=>{let r=0;const i=()=>{const t=Date.now();t-r<800||(r=t,c.current())},d=setInterval(()=>document.visibilityState==="visible"&&i(),o);let e=null,s=!1;m(async()=>{const{io:t}=await import("./index-D4pQg9dP.js");return{io:t}},[]).then(({io:t})=>{if(s)return;const l=t(`${location.origin}/${location.hostname}`,{path:"/socket.io",withCredentials:!0,reconnectionAttempts:3,timeout:4e3});l.on("pep_changed",i),e=l}).catch(()=>{});const a=()=>document.visibilityState==="visible"&&i();return document.addEventListener("visibilitychange",a),()=>{s=!0,e==null||e.close(),clearInterval(d),document.removeEventListener("visibilitychange",a)}},[o])}export{p as C,b as u};
