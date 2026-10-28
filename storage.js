const DB_NAME='svoyaki-production-offline-v1';
const VERSION=1;
let handle;
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
export async function openStorage(){
  if(handle)return handle;
  handle=await new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('records'))db.createObjectStore('records',{keyPath:'id'});
      if(!db.objectStoreNames.contains('pending'))db.createObjectStore('pending',{keyPath:'id'});
      if(!db.objectStoreNames.contains('settings'))db.createObjectStore('settings',{keyPath:'key'});
    };
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  return handle;
}
export async function readAll(store){const db=await openStorage();return request(db.transaction(store,'readonly').objectStore(store).getAll());}
export async function readOne(store,key){const db=await openStorage();return request(db.transaction(store,'readonly').objectStore(store).get(key));}
export async function writeOne(store,item){const db=await openStorage();return request(db.transaction(store,'readwrite').objectStore(store).put(item));}
export async function deleteOne(store,key){const db=await openStorage();return request(db.transaction(store,'readwrite').objectStore(store).delete(key));}
export async function saveLocal(id,data,kind='episode'){
  const db=await openStorage();
  // One atomic transaction: a sudden app closure must not leave a local edit
  // without its corresponding offline-sync queue entry.
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['records','pending'],'readwrite');
    const records=tx.objectStore('records'), queue=tx.objectStore('pending');
    let prior=null,pending=null,got=0,result=null;
    const r1=records.get(id),r2=queue.get(id);
    const process=()=>{
      if(++got!==2)return;
      const stamp=crypto.randomUUID();
      result={id,kind,data,version:prior?.version||0,stamp,updatedAt:new Date().toISOString()};
      records.put(result);
      queue.put({id,kind,data,baseVersion:pending?.baseVersion??(prior?.version||0),stamp});
    };
    r1.onsuccess=()=>{prior=r1.result;process();};
    r2.onsuccess=()=>{pending=r2.result;process();};
    tx.oncomplete=()=>resolve(result);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error);
  });
}

export async function mergeRemote(remote){
  const pendingIds=new Set((await readAll('pending')).map(x=>x.id));
  for(const rec of remote){if(!pendingIds.has(rec.id))await writeOne('records',rec);}
}
export async function acceptServer(saved){
  const pending=await readOne('pending',saved.id);
  const local=await readOne('records',saved.id);
  if(pending && pending.stamp===saved.stamp){
    await deleteOne('pending',saved.id);
    await writeOne('records',{...local,version:saved.version,stamp:saved.stamp,updatedAt:saved.updatedAt});
  } else if(pending){
    // A local edit occurred mid-flight: carry forward the new server version.
    await writeOne('pending',{...pending,baseVersion:saved.version});
    await writeOne('records',{...local,version:saved.version});
  } else await writeOne('records',saved);
}
export async function setting(key,value){if(arguments.length===1)return (await readOne('settings',key))?.value;await writeOne('settings',{key,value});}