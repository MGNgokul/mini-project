(function(){
  "use strict";

  const SESSION_KEY = "skillvaultUser";
  const META_KEY = "skillvaultRealtimeMeta";
  const DEFAULT_CONFIG = {
    enabled: false,
    firebaseConfig: {
      apiKey: "",
      authDomain: "",
      databaseURL: "",
      projectId: "",
      storageBucket: "",
      messagingSenderId: "",
      appId: ""
    },
    basePath: "skillvault/v1",
    syncKeys: [
      "skillvaultSkills",
      "skillvaultRoadmap",
      "profileData",
      "settings",
      "skillvaultUsers"
    ],
    globalKeys: ["skillvaultUsers"],
    debounceMs: 250
  };

  const runtimeConfig = Object.assign({}, DEFAULT_CONFIG, window.SKILLVAULT_REALTIME || {});
  runtimeConfig.firebaseConfig = Object.assign({}, DEFAULT_CONFIG.firebaseConfig, (window.SKILLVAULT_REALTIME && window.SKILLVAULT_REALTIME.firebaseConfig) || {});
  runtimeConfig.syncKeys = Array.isArray(runtimeConfig.syncKeys) ? runtimeConfig.syncKeys.slice() : DEFAULT_CONFIG.syncKeys.slice();
  runtimeConfig.globalKeys = Array.isArray(runtimeConfig.globalKeys) ? runtimeConfig.globalKeys.slice() : DEFAULT_CONFIG.globalKeys.slice();

  if(!runtimeConfig.enabled){
    return;
  }

  if(!window.firebase || typeof window.firebase.initializeApp !== "function"){
    console.warn("[SkillVault realtime] Firebase SDK not found. Sync disabled.");
    return;
  }

  if(!runtimeConfig.firebaseConfig.databaseURL){
    console.warn("[SkillVault realtime] Missing firebaseConfig.databaseURL. Sync disabled.");
    return;
  }

  function safeParse(value, fallback){
    try{
      const parsed = JSON.parse(value);
      return parsed === null ? fallback : parsed;
    }catch{
      return fallback;
    }
  }

  function getCurrentEmail(){
    const session = safeParse(localStorage.getItem(SESSION_KEY), null);
    if(!session || typeof session !== "object"){
      return "guest";
    }
    const email = String(session.email || "").trim().toLowerCase();
    return email || "guest";
  }

  function toPathSafeId(value){
    return String(value || "guest").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function getMetaStore(){
    const meta = safeParse(localStorage.getItem(META_KEY), {});
    return meta && typeof meta === "object" ? meta : {};
  }

  function setMetaTimestamp(key, timestamp){
    const meta = getMetaStore();
    meta[key] = Number.isFinite(timestamp) ? timestamp : Date.now();
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  function getMetaTimestamp(key){
    const meta = getMetaStore();
    const value = Number(meta[key]);
    return Number.isFinite(value) ? value : 0;
  }

  const app = window.firebase.apps && window.firebase.apps.length
    ? window.firebase.apps[0]
    : window.firebase.initializeApp(runtimeConfig.firebaseConfig);

  const db = window.firebase.database(app);

  let activeUserId = null;
  let applyingRemote = false;
  const unsubs = [];
  const writeTimers = {};

  function clearListeners(){
    while(unsubs.length){
      const stop = unsubs.pop();
      try{ stop(); }catch{}
    }
  }

  function buildPath(key, userId){
    const base = String(runtimeConfig.basePath || "skillvault/v1").replace(/\/+$/, "");
    if(runtimeConfig.globalKeys.indexOf(key) >= 0){
      return base + "/global/" + key;
    }
    return base + "/users/" + userId + "/storage/" + key;
  }

  function queueRemoteWrite(key, rawValue, userId){
    const timerKey = userId + "::" + key;
    if(writeTimers[timerKey]){
      clearTimeout(writeTimers[timerKey]);
    }

    writeTimers[timerKey] = setTimeout(function(){
      delete writeTimers[timerKey];
      const payload = {
        updatedAt: Date.now(),
        json: rawValue === null ? null : String(rawValue)
      };
      setMetaTimestamp(key, payload.updatedAt);
      db.ref(buildPath(key, userId)).set(payload).catch(function(err){
        console.warn("[SkillVault realtime] write failed for", key, err && err.message ? err.message : err);
      });
    }, runtimeConfig.debounceMs);
  }

  function applyRemoteSnapshot(key, snapshot){
    const remote = snapshot.val();
    if(!remote || typeof remote !== "object"){
      return;
    }

    const remoteAt = Number(remote.updatedAt);
    const localAt = getMetaTimestamp(key);
    if(Number.isFinite(remoteAt) && localAt && remoteAt < localAt){
      return;
    }

    const remoteJson = remote.json === null ? null : String(remote.json || "");
    const current = localStorage.getItem(key);
    if(remoteJson === current){
      setMetaTimestamp(key, remoteAt || Date.now());
      return;
    }

    applyingRemote = true;
    try{
      if(remoteJson === null){
        localStorage.removeItem(key);
      }else{
        localStorage.setItem(key, remoteJson);
      }
      setMetaTimestamp(key, remoteAt || Date.now());
      window.dispatchEvent(new StorageEvent("storage", { key: key, newValue: remoteJson, oldValue: current, storageArea: localStorage }));
    }finally{
      applyingRemote = false;
    }
  }

  function reconcileInitial(key, userId){
    const ref = db.ref(buildPath(key, userId));
    return ref.get().then(function(snapshot){
      const remote = snapshot.val();
      const localRaw = localStorage.getItem(key);

      if(!remote && localRaw !== null){
        queueRemoteWrite(key, localRaw, userId);
        return;
      }

      if(remote && localRaw === null){
        applyRemoteSnapshot(key, snapshot);
        return;
      }

      if(remote && localRaw !== null){
        applyRemoteSnapshot(key, snapshot);
      }
    }).catch(function(err){
      console.warn("[SkillVault realtime] initial sync failed for", key, err && err.message ? err.message : err);
    });
  }

  function bindForUser(userId){
    clearListeners();

    runtimeConfig.syncKeys.forEach(function(key){
      const ref = db.ref(buildPath(key, userId));
      const cb = function(snapshot){
        applyRemoteSnapshot(key, snapshot);
      };

      ref.on("value", cb);
      unsubs.push(function(){ ref.off("value", cb); });

      reconcileInitial(key, userId);
    });
  }

  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);

  localStorage.setItem = function(key, value){
    originalSetItem(key, value);
    if(applyingRemote){
      return;
    }
    if(runtimeConfig.syncKeys.indexOf(key) === -1){
      if(key === SESSION_KEY){
        maybeRebind();
      }
      return;
    }
    queueRemoteWrite(key, value, activeUserId || toPathSafeId(getCurrentEmail()));
  };

  localStorage.removeItem = function(key){
    originalRemoveItem(key);
    if(applyingRemote){
      return;
    }
    if(runtimeConfig.syncKeys.indexOf(key) >= 0){
      queueRemoteWrite(key, null, activeUserId || toPathSafeId(getCurrentEmail()));
    }
    if(key === SESSION_KEY){
      maybeRebind();
    }
  };

  function maybeRebind(){
    const nextUser = toPathSafeId(getCurrentEmail());
    if(nextUser === activeUserId){
      return;
    }
    activeUserId = nextUser;
    bindForUser(activeUserId);
  }

  window.addEventListener("storage", function(event){
    if(event.key === SESSION_KEY){
      maybeRebind();
    }
    if(applyingRemote){
      return;
    }
    if(event.key && runtimeConfig.syncKeys.indexOf(event.key) >= 0){
      queueRemoteWrite(event.key, localStorage.getItem(event.key), activeUserId || toPathSafeId(getCurrentEmail()));
    }
  });

  maybeRebind();
})();
