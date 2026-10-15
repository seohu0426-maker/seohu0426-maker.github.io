'use strict';
(function(){
 const el=s=>document.querySelector(s),KEY='jarvis_push_session_v1';
 let session={token:'',revision:0,offset:10,details:false,consent:false};try{session={...session,...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch{}
 let serverState=null,registration=null,syncBusy=false,needsSync=false,debounce=null,deferredInstall=null,networkBusy=false;
 const writeSession=()=>localStorage.setItem(KEY,JSON.stringify(session));
 function status(t){el('#pushStatus').textContent=t;}
 function fail(e){status(e.message||'요청을 완료하지 못했습니다. 이전 예약이 서버에 남아 있을 수 있습니다.');}
 async function api(url,method='GET',body){let r;try{r=await fetch(url,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session.token?{Authorization:'Bearer '+session.token}:{})},body:body!==undefined?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(25000)})}catch{throw Error('서버에 연결하지 못했습니다. 변경이 서버에 반영되지 않았을 수 있으니 상태를 확인하세요.')}let data;try{data=await r.json()}catch{throw Error('알림 서버 API가 없습니다. 정적 HTML 호스팅만으로는 서버 푸시가 작동하지 않습니다.')}if(!r.ok){const e=Error(data.error||'서버 오류');e.status=r.status;throw e}return data}
 const supported=()=>isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 function summary(){if(!serverState)return;status(`서버 연결됨 · ${serverState.enabled&&serverState.subscribed?'푸시 등록됨':'푸시 꺼짐'}\n향후 일정 ${serverState.eventCount}개 · 대기 ${serverState.pending}개 · 발송 요청 수락 ${serverState.accepted}개\n브라우저 권한: ${'Notification' in window?Notification.permission:'미지원'} · 기기 수신은 직접 확인해야 합니다.${localStorage.getItem('jarvis_push_dirty')?'\n주의: 로컬 변경이 아직 서버에 반영되지 않았습니다.':''}`);}
 async function refresh(){if(!session.token){status('알림 서버 연결 전 · 아직 예약된 웹 푸시가 없습니다.');return}serverState=await api('/api/status');session.revision=Math.max(session.revision,serverState.revision);writeSession();summary();}
 function collect(){const now=Date.now(),max=now+90*86400000;const list=events.map(e=>({id:e.id,title:e.title,startMs:new Date(e.date+'T'+e.start+':00').getTime(),endMs:new Date(e.date+'T'+e.end+':00').getTime(),day:e.date})).filter(e=>e.startMs>now&&e.startMs<=max);if(list.length>500)throw Error('향후 90일 일정이 500개를 초과해 동기화하지 못했습니다. 이전 서버 예약이 남아 있을 수 있습니다.');return list;}
 function markDirty(){try{localStorage.setItem('jarvis_push_dirty','1')}catch{}if(!session.token||!serverState?.enabled)return;needsSync=true;clearTimeout(debounce);debounce=setTimeout(()=>syncNow().catch(fail),500);}
 async function syncNow(){if(!session.token)throw Error('서버를 먼저 연결해주세요.');if(!session.consent)throw Error('일정 정보의 서버 저장에 동의해야 합니다.');if(syncBusy){needsSync=true;return}syncBusy=true;try{do{needsSync=false;const snapshot=collect();session.revision=Math.max(session.revision,serverState?.revision||0)+1;writeSession();try{serverState=await api('/api/sync','POST',{revision:session.revision,events:snapshot})}catch(e){if(e.status===409)await refresh();throw e}if(!needsSync)localStorage.removeItem('jarvis_push_dirty');summary();}while(needsSync)}finally{syncBusy=false}}
 async function reg(){if(!isSecureContext)throw Error('푸시는 HTTPS 사이트에서만 사용할 수 있습니다.');if(!('serviceWorker' in navigator))throw Error('서비스 워커를 지원하지 않는 브라우저입니다.');if(!registration){await navigator.serviceWorker.register('/sw.js');registration=await navigator.serviceWorker.ready;}return registration;}
 const buf=s=>{const raw=atob((s+'='.repeat((4-s.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));};
 async function guarded(fn){if(networkBusy){toast('이전 요청을 처리 중입니다.');return}networkBusy=true;try{await fn()}catch(e){fail(e)}finally{networkBusy=false}}
 el('#pushCode').value='';el('#pushOffset').value=String(session.offset);el('#pushDetails').checked=session.details;el('#pushConsent').checked=session.consent;
 el('#pushConnect').onclick=()=>guarded(async()=>{const code=el('#pushCode').value;if(!code)throw Error('서버 운영자가 만든 접속 코드를 입력해주세요. AI API 키가 아닙니다.');const data=await api('/api/connect','POST',{code});session.token=data.token;session.revision=data.revision;writeSession();el('#pushCode').value='';await refresh()});
 el('#pushEnable').onclick=()=>guarded(async()=>{
  if(!supported())throw Error('HTTPS와 서비스 워커·웹 푸시를 지원하는 브라우저가 필요합니다. Chrome Android에서 확인해주세요.');if(!session.token)throw Error('운영자 접속 코드로 서버를 먼저 연결해주세요.');if(!el('#pushConsent').checked)throw Error('일정 제목·시각을 내 알림 서버에 저장하는 데 동의해주세요.');
  session.consent=true;session.offset=Number(el('#pushOffset').value);session.details=el('#pushDetails').checked;writeSession();
  // Ask permission directly in this user action, before asynchronous subscription work.
  let permission=Notification.permission;if(permission==='default')permission=await Notification.requestPermission();if(permission!=='granted')throw Error('알림 권한이 허용되지 않았습니다. 서버 푸시를 켜지 않았습니다.');
  const registration=await reg();const cfg=await api('/api/config');let sub=await registration.pushManager.getSubscription();if(!sub)sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:buf(cfg.publicKey)});
  await api('/api/settings','POST',{offsetMinutes:session.offset,showDetails:session.details});await syncNow();serverState=await api('/api/subscribe','POST',{subscription:sub.toJSON()});summary();toast('푸시 구독과 서버 예약을 등록했습니다. 테스트 알림으로 실제 수신을 확인해주세요.');
 });
 el('#pushSync').onclick=()=>guarded(async()=>{await refresh();await syncNow()});
 el('#pushRefresh').onclick=()=>guarded(refresh);
 el('#pushTest').onclick=()=>guarded(async()=>{await api('/api/test','POST',{});status('푸시 서비스가 테스트 발송 요청을 수락했습니다. 휴대폰에 실제 알림이 도착했는지 확인해주세요. 수신 완료를 자동으로 확인한 것은 아닙니다.');});
 el('#pushDisable').onclick=()=>guarded(async()=>{if(!session.token)throw Error('연결된 서버가 없습니다.');serverState=await api('/api/disable','POST',{});try{const r=await reg(),s=await r.pushManager.getSubscription();if(s)await s.unsubscribe()}catch{}summary();toast('서버의 새 알림 발송을 껐습니다. 이미 발송된 알림은 회수하지 못할 수 있습니다.');});
 el('#pushDelete').onclick=()=>guarded(async()=>{if(!session.token)throw Error('연결된 서버가 없습니다.');if(!confirm('이 기기의 서버 일정·구독·예약을 모두 삭제할까요?\n휴대폰 안의 로컬 일정은 유지합니다.'))return;await api('/api/device','DELETE');try{const r=await reg(),s=await r.pushManager.getSubscription();if(s)await s.unsubscribe()}catch{}session.token='';session.revision=0;writeSession();serverState=null;status('이 기기의 서버 데이터를 삭제했습니다. 로컬 일정은 유지했습니다.');});
 const updateSettings=()=>guarded(async()=>{session.offset=Number(el('#pushOffset').value);session.details=el('#pushDetails').checked;writeSession();if(!session.token)return;serverState=await api('/api/settings','POST',{offsetMinutes:session.offset,showDetails:session.details});summary()});
 el('#pushOffset').onchange=updateSettings;el('#pushDetails').onchange=updateSettings;
 const originalPersist=persist;persist=function(){const ok=originalPersist();if(ok)markDirty();return ok};
 window.addEventListener('online',()=>{if(session.token)refresh().then(()=>{if(localStorage.getItem('jarvis_push_dirty')&&serverState.enabled)return syncNow()}).catch(fail)});
 el('#installPwa').onclick=async()=>{if(deferredInstall){await deferredInstall.prompt();const choice=await deferredInstall.userChoice;toast(choice.outcome==='accepted'?'설치 요청을 승인했습니다. 홈 화면 아이콘을 확인해주세요.':'설치를 취소했습니다.');deferredInstall=null}else toast('브라우저 메뉴의 ‘설치’ 또는 ‘홈 화면에 추가’를 확인해주세요. HTTPS 사이트로 열어야 합니다.');};
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;el('#installStatus').textContent='브라우저가 설치를 지원합니다.'});window.addEventListener('appinstalled',()=>el('#installStatus').textContent='브라우저에서 설치 이벤트를 확인했습니다.');
 if(matchMedia('(display-mode: standalone)').matches)el('#installStatus').textContent='설치형 창으로 실행 중';
 if(isSecureContext&&'serviceWorker' in navigator)reg().then(()=>el('#offlineStatus').textContent='오프라인 앱 화면을 준비했습니다. 서버 푸시는 인터넷과 서버가 계속 필요합니다.').catch(()=>el('#offlineStatus').textContent='오프라인 준비 실패. 배포 경로와 서비스 워커를 확인해주세요.');
 if(!supported())status('현재 환경에서는 웹 푸시를 사용할 수 없습니다. HTTPS 주소와 지원 브라우저가 필요합니다.');else refresh().then(()=>{if(session.token&&session.consent&&serverState?.enabled)return syncNow()}).catch(fail);
 const date=new URL(location.href).searchParams.get('date');if(/^\d{4}-\d{2}-\d{2}$/.test(date||'')&&dayKey(dateOf(date))===date){selected=date;month=new Date(dateOf(date).getFullYear(),dateOf(date).getMonth(),1);render();tab('calendar');}
})();
